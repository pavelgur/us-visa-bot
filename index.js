#!/usr/bin/env node

import fetch from "node-fetch";
import cheerio from 'cheerio';

const EMAIL = process.env.EMAIL
const PASSWORD = process.env.PASSWORD
const SCHEDULE_ID = process.env.SCHEDULE_ID
// Parse comma-separated facility IDs into an array
const FACILITY_IDS = process.env.FACILITY_ID.split(',').map(id => id.trim())
const LOCALE = process.env.LOCALE
const REFRESH_DELAY = Number(process.env.REFRESH_DELAY || 3)

const BASE_URI = `https://ais.usvisa-info.com/${LOCALE}/niv`

// Custom error class for session expiration
class SessionExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

async function main(currentBookedDate) {
  if (!currentBookedDate) {
    log(`Invalid current booked date: ${currentBookedDate}`)
    process.exit(1)
  }

  log(`Initializing with current date ${currentBookedDate}`)
  log(`Checking ${FACILITY_IDS.length} facilities: ${FACILITY_IDS.join(', ')}`)

  let sessionHeaders = await login()

  while(true) {
    try {
      const result = await checkAvailableDateAllFacilities(sessionHeaders)

      if (!result) {
        log("no dates available at any facility")
      } else if (result.date > currentBookedDate) {
        log(`nearest date is further than already booked (${currentBookedDate} vs ${result.date} at facility ${result.facilityId})`)
      } else {
        currentBookedDate = result.date
        const time = await checkAvailableTime(sessionHeaders, result.date, result.facilityId)

        book(sessionHeaders, result.date, time, result.facilityId)
          .then(d => log(`booked time at ${result.date} ${time} at facility ${result.facilityId}`))
      }

      await sleep(REFRESH_DELAY)
    } catch(err) {
      if (err instanceof SessionExpiredError) {
        log("Session expired. Logging in again...")
        try {
          sessionHeaders = await login()
          log("Successfully logged in again")
        } catch (loginError) {
          console.error("Error during re-login:", loginError)
          await sleep(REFRESH_DELAY * 2) // Wait a bit longer before retrying
        }
      } else {
        console.error("Error during operation:", err)
        await sleep(REFRESH_DELAY) // Standard delay before retry
      }
    }
  }
}

async function login() {
  log(`Logging in`)

  const anonymousHeaders = await fetch(`${BASE_URI}/users/sign_in`, {
    headers: {
      "User-Agent": "",
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
    },
  })
    .then(response => extractHeaders(response))

  return fetch(`${BASE_URI}/users/sign_in`, {
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
    .then(res => (
      Object.assign({}, anonymousHeaders, {
        'Cookie': extractRelevantCookies(res)
      })
    ))
}

// New function to check dates across all facilities
async function checkAvailableDateAllFacilities(headers) {
  let bestResult = null;
  
  // Calculate the minimum valid date (2 days from now)
  const today = new Date();
  const minValidDate = new Date();
  minValidDate.setDate(today.getDate() + 2);
  minValidDate.setHours(0, 0, 0, 0); // Start of day
  
  log(`Checking dates for ${FACILITY_IDS.length} facilities...`);
  
  let sessionExpired = false;
  
  // Check each facility and track the best result
  for (const facilityId of FACILITY_IDS) {
    try {
      const dates = await checkAvailableDatesForFacility(headers, facilityId);
      
      if (!dates || dates.length === 0) {
        log(`No dates available for facility ${facilityId}`);
        continue;
      }
      
      // Filter dates that are at least 2 days from now
      const validDates = dates.filter(dateObj => {
        const appointmentDate = new Date(dateObj.date);
        return appointmentDate >= minValidDate;
      });
      
      if (validDates.length === 0) {
        log(`No valid dates (at least 2 days from now) for facility ${facilityId}`);
        continue;
      }
      
      // Sort dates and get the earliest valid one
      validDates.sort((a, b) => new Date(a.date) - new Date(b.date));
      const earliestDate = validDates[0].date;
      
      log(`Facility ${facilityId}: earliest date available is ${earliestDate}`);
      
      // If this is our first valid result or it's better than our previous best, update it
      if (!bestResult || earliestDate < bestResult.date) {
        bestResult = {
          date: earliestDate,
          facilityId: facilityId
        };
      }
    } catch (error) {
      log(`Error checking facility ${facilityId}: ${error.message}`);
      
      // If this is a session expiration error, flag it but continue checking other facilities
      if (error instanceof SessionExpiredError) {
        sessionExpired = true;
      }
    }
  }
  
  // After checking all facilities, if we encountered a session expiration, throw it
  if (sessionExpired) {
    throw new SessionExpiredError("Your session expired, please sign in again to continue.");
  }
  
  if (bestResult) {
    log(`Best available date is ${bestResult.date} at facility ${bestResult.facilityId}`);
  }
  
  return bestResult;
}

// Modified to check dates for a single facility
function checkAvailableDatesForFacility(headers, facilityId) {
  return fetch(`${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/days/${facilityId}.json?appointments[expedite]=false`, {
    "headers": Object.assign({}, headers, {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    }),
    "cache": "no-store"
  })
    .then(r => r.json())
    .then(r => handleErrors(r));
}

// Updated to include facilityId parameter
function checkAvailableTime(headers, date, facilityId) {
  return fetch(`${BASE_URI}/schedule/${SCHEDULE_ID}/appointment/times/${facilityId}.json?date=${date}&appointments[expedite]=false`, {
    "headers": Object.assign({}, headers, {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    }),
    "cache": "no-store",
  })
    .then(r => r.json())
    .then(r => handleErrors(r))
    .then(d => d['business_times'][0] || d['available_times'][0])
}

function handleErrors(response) {
  const errorMessage = response['error']

  if (errorMessage) {
    // Check if the error is related to session expiration
    if (errorMessage.includes("session expired") || errorMessage.includes("sign in again")) {
      throw new SessionExpiredError(errorMessage);
    }
    throw new Error(errorMessage);
  }

  return response
}

// Updated to include facilityId parameter
async function book(headers, date, time, facilityId) {
  const url = `${BASE_URI}/schedule/${SCHEDULE_ID}/appointment`

  const newHeaders = await fetch(url, { "headers": headers })
    .then(response => extractHeaders(response))
    .catch(error => {
      // Check for session expiration in the response
      if (error.message && (error.message.includes("session expired") || error.message.includes("sign in again"))) {
        throw new SessionExpiredError(error.message);
      }
      throw error;
    });

  return fetch(url, {
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
      'appointments[consulate_appointment][facility_id]': facilityId,
      'appointments[consulate_appointment][date]': date,
      'appointments[consulate_appointment][time]': time,
      'appointments[asc_appointment][facility_id]': '',
      'appointments[asc_appointment][date]': '',
      'appointments[asc_appointment][time]': ''
    }),
  })
  .then(response => {
    if (!response.ok) {
      return response.text().then(text => {
        if (text.includes("session expired") || text.includes("sign in again")) {
          throw new SessionExpiredError("Session expired during booking");
        }
        throw new Error(`Booking failed: ${response.status} ${response.statusText}`);
      });
    }
    return response;
  });
}

async function extractHeaders(res) {
  const cookies = extractRelevantCookies(res)

  const html = await res.text()
  const $ = cheerio.load(html);
  const csrfToken = $('meta[name="csrf-token"]').attr('content')

  // Check if the page indicates a session expiration
  if (html.includes("session expired") || html.includes("sign in again") || !csrfToken) {
    throw new SessionExpiredError("Session expired while extracting headers");
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
}

function extractRelevantCookies(res) {
  const cookieHeader = res.headers.get('set-cookie')
  if (!cookieHeader) {
    throw new Error("No cookies in response");
  }
  
  const parsedCookies = parseCookies(cookieHeader)
  if (!parsedCookies['_yatri_session']) {
    throw new SessionExpiredError("Session cookie not found");
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