#!/usr/bin/env node

import fetch from "node-fetch";
import cheerio from 'cheerio';

const EMAIL = process.env.EMAIL
const PASSWORD = process.env.PASSWORD
const SCHEDULE_ID = process.env.SCHEDULE_ID
const FACILITY_ID = process.env.FACILITY_ID
const LOCALE = process.env.LOCALE
const REFRESH_DELAY = Number(process.env.REFRESH_DELAY || 3)

const BASE_URI = `https://ais.usvisa-info.com/${LOCALE}/niv`

// Track booking history
const bookingHistory = [];

async function main(currentBookedDate) {
  if (!currentBookedDate) {
    log(`Invalid current booked date: ${currentBookedDate}`)
    process.exit(1)
  }

  // Check if date is in valid format (YYYY-MM-DD)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(currentBookedDate)) {
    log(`Invalid date format: ${currentBookedDate}. Please use YYYY-MM-DD format.`)
    process.exit(1)
  }

  log(`Initializing with current date ${currentBookedDate}`)
  
  // Add initial booking to history
  bookingHistory.push({
    date: new Date().toISOString(),
    action: 'initial',
    appointmentDate: currentBookedDate
  });
  
  // Show initial status
  displayBookingStatus(currentBookedDate);

  try {
    let sessionHeaders = await login()

    while(true) {
      try {
        // Get all available dates
        const dates = await checkAllAvailableDates(sessionHeaders)

        if (!dates || dates.length === 0) {
          log("No dates available")
        } else {
          // Filter for eligible dates (at least tomorrow and before current booking)
          const tomorrow = new Date()
          tomorrow.setDate(tomorrow.getDate() + 1)
          const tomorrowStr = tomorrow.toISOString().split('T')[0]
          
          const eligibleDates = dates
            .filter(date => date >= tomorrowStr && date < currentBookedDate)
            .sort() // Sort from earliest to latest
          
          if (eligibleDates.length === 0) {
            log(`No eligible dates found (must be after ${tomorrowStr} and before ${currentBookedDate})`)
          } else {
            log(`Found ${eligibleDates.length} eligible dates: ${eligibleDates.join(', ')}`)
            
            // Try each date in order
            for (const date of eligibleDates) {
              try {
                // Get available time for this date
                const time = await checkAvailableTime(sessionHeaders, date)
                
                if (!time) {
                  log(`No available time slots for date ${date}, skipping`)
                  continue
                }
                
                log(`Attempting to book date ${date} at time ${time}`)
                
                // Try to book
                const bookingSuccess = await book(sessionHeaders, date, time)
                
                if (bookingSuccess) {
                  log(`Successfully booked appointment for ${date} at ${time}`)
                  
                  // Update current booked date
                  const oldDate = currentBookedDate
                  currentBookedDate = date
                  
                  // Add to history
                  bookingHistory.push({
                    date: new Date().toISOString(),
                    action: 'booked',
                    oldAppointmentDate: oldDate,
                    newAppointmentDate: date,
                    appointmentTime: time
                  });
                  
                  // Display booking history
                  displayBookingStatus(currentBookedDate);
                  
                  // Break out of the loop - we've booked the earliest date
                  break
                } else {
                  log(`Booking attempt for ${date} was not successful, continuing with next date`)
                }
                
              } catch (bookingError) {
                log(`Error booking date ${date}: ${bookingError.message}`)
                
                // If session expired, re-login and continue with next date
                if (bookingError.message.includes('session expired')) {
                  log(`Session expired during booking, logging in again`)
                  sessionHeaders = await login()
                }
              }
            }
          }
        }
      } catch (error) {
        log(`Error checking available dates: ${error.message}`)
        
        // If session expired, re-login
        if (error.message.includes('session expired')) {
          log(`Session expired, logging in again`)
          sessionHeaders = await login()
        }
      }

      await sleep(REFRESH_DELAY)
    }

  } catch(err) {
    console.error(err)
    log("Trying again")
    
    // Add error to history
    bookingHistory.push({
      date: new Date().toISOString(),
      action: 'error',
      message: err.message
    });

    main(currentBookedDate)
  }
}

function displayBookingStatus(currentDate) {
  log('===== BOOKING STATUS =====')
  log(`Current appointment date: ${currentDate}`)
  log('Booking history:')
  
  if (bookingHistory.length === 0) {
    log('No booking history yet')
  } else {
    bookingHistory.forEach((entry, index) => {
      if (entry.action === 'initial') {
        log(`${index + 1}. [${entry.date}] Started with initial date: ${entry.appointmentDate}`)
      } else if (entry.action === 'booked') {
        log(`${index + 1}. [${entry.date}] Rebooked from ${entry.oldAppointmentDate} to ${entry.newAppointmentDate} at ${entry.appointmentTime}`)
      } else if (entry.action === 'error') {
        log(`${index + 1}. [${entry.date}] Error: ${entry.message}`)
      }
    })
  }
  
  log('==========================')
}

async function login() {
  log(`Logging in`)

  try {
    const anonymousHeaders = await fetch(`${BASE_URI}/users/sign_in`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
      },
    })
      .then(response => extractHeaders(response))

    const loginResponse = await fetch(`${BASE_URI}/users/sign_in`, {
      "headers": Object.assign({}, anonymousHeaders, {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      }),
      "method": "POST",
      "body": new URLSearchParams({
        'utf8': '✓',
        'user[email]': EMAIL,
        'user[password]': PASSWORD,
        'policy_confirmed': '1',
        'commit': 'Acessar'
      }),
    })
    
    if (!loginResponse.ok) {
      throw new Error(`Login failed with status: ${loginResponse.status}`)
    }
    
    return Object.assign({}, anonymousHeaders, {
      'Cookie': extractRelevantCookies(loginResponse)
    })
  } catch (error) {
    log(`Login error: ${error.message}`)
    throw error
  }
}

// Modified to return all available dates
async function checkAllAvailableDates(headers) {
  try {
    const response = await fetch(`${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/days/${FACILITY_ID}.json?appointments[expedite]=false`, {
      "headers": Object.assign({}, headers, {
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      }),
      "cache": "no-store"
    })
    
    if (!response.ok) {
      const text = await response.text()
      if (text.includes('session expired')) {
        throw new Error('Your session expired, please sign in again to continue.')
      }
      throw new Error(`Failed to fetch available dates: ${response.status}`)
    }
    
    const data = await response.json()
    
    // Check for error response
    if (data.error) {
      if (data.error.includes('session expired')) {
        throw new Error('Your session expired, please sign in again to continue.')
      }
      throw new Error(data.error)
    }
    
    // Extract dates from the response - data is an array of objects with 'date' property
    return data.map(item => item.date)
  } catch (error) {
    // Pass through session expired errors
    if (error.message.includes('session expired')) {
      throw error
    }
    
    // Log other errors
    log(`Error fetching available dates: ${error.message}`)
    return []
  }
}

async function checkAvailableTime(headers, date) {
  try {
    const response = await fetch(`${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/times/${FACILITY_ID}.json?date=${date}&appointments[expedite]=false`, {
      "headers": Object.assign({}, headers, {
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      }),
      "cache": "no-store",
    })
    
    if (!response.ok) {
      const text = await response.text()
      if (text.includes('session expired')) {
        throw new Error('Your session expired, please sign in again to continue.')
      }
      throw new Error(`Failed to fetch available times: ${response.status}`)
    }
    
    const data = await response.json()
    
    // Check for error response
    if (data.error) {
      if (data.error.includes('session expired')) {
        throw new Error('Your session expired, please sign in again to continue.')
      }
      throw new Error(data.error)
    }
    
    // Return the first available time slot
    return data['business_times'][0] || data['available_times'][0]
  } catch (error) {
    // Pass through session expired errors
    if (error.message.includes('session expired')) {
      throw error
    }
    
    // Log other errors
    log(`Error fetching available times for date ${date}: ${error.message}`)
    return null
  }
}

async function book(headers, date, time) {
  try {
    const url = `${BASE_URI}/schedule/${SCHEDULE_ID}/appointment`

    const response = await fetch(url, { "headers": headers })
    
    if (!response.ok) {
      const text = await response.text()
      if (text.includes('session expired')) {
        throw new Error('Your session expired, please sign in again to continue.')
      }
      throw new Error(`Failed to prepare booking request: ${response.status}`)
    }
    
    const newHeaders = await extractHeaders(response)

    const bookingResponse = await fetch(url, {
      "method": "POST",
      "redirect": "follow",
      "headers": Object.assign({}, newHeaders, {
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
      "body": new URLSearchParams({
        'utf8': '✓',
        'authenticity_token': newHeaders['X-CSRF-Token'],
        'confirmed_limit_message': '1',
        'use_consulate_appointment_capacity': 'true',
        'appointments[consulate_appointment][facility_id]': FACILITY_ID,
        'appointments[consulate_appointment][date]': date,
        'appointments[consulate_appointment][time]': time,
        'appointments[asc_appointment][facility_id]': '',
        'appointments[asc_appointment][date]': '',
        'appointments[asc_appointment][time]': ''
      }),
    })
    
    if (!bookingResponse.ok) {
      const text = await bookingResponse.text()
      if (text.includes('session expired')) {
        throw new Error('Your session expired, please sign in again to continue.')
      }
      throw new Error(`Booking failed with status: ${bookingResponse.status}`)
    }
    
    // If we reach here, the booking API call was successful (200 OK)
    // We'll consider this a successful booking
    return true
  } catch (error) {
    // Check for session expiration
    if (error.message.includes('session expired')) {
      throw error
    }
    
    log(`Booking error: ${error.message}`)
    throw error
  }
}

async function extractHeaders(res) {
  try {
    const cookies = extractRelevantCookies(res)

    const html = await res.text()
    const $ = cheerio.load(html);
    const csrfToken = $('meta[name="csrf-token"]').attr('content')

    if (!csrfToken) {
      throw new Error('Could not extract CSRF token, session may have expired')
    }

    return {
      "Cookie": cookies,
      "X-CSRF-Token": csrfToken,
      "Referer": BASE_URI,
      "Referrer-Policy": "strict-origin-when-cross-origin",
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive'
    }
  } catch (error) {
    if (error.message.includes('CSRF token')) {
      throw new Error('Your session expired, please sign in again to continue.')
    }
    throw error
  }
}

function extractRelevantCookies(res) {
  const cookieHeader = res.headers.get('set-cookie')
  
  if (!cookieHeader) {
    throw new Error('No cookies found in response, session may have expired')
  }
  
  const parsedCookies = parseCookies(cookieHeader)
  
  if (!parsedCookies['_yatri_session']) {
    throw new Error('Session cookie not found, session may have expired')
  }
  
  return `_yatri_session=${parsedCookies['_yatri_session']}`
}

function parseCookies(cookies) {
  const parsedCookies = {}

  cookies.split(';').map(c => c.trim()).forEach(c => {
    const [name, value] = c.split('=', 2)
    parsedCookies[name] = value
  })

  return parsedCookies
}

function sleep(s) {
  return new Promise((resolve) => {
    setTimeout(resolve, s * 1000);
  });
}

function log(message) {
  console.log(`[${new Date().toISOString()}]`, message)
}

const args = process.argv.slice(2);
const currentBookedDate = args[0]
main(currentBookedDate)