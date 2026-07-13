// time.js — Bali is WITA (UTC+8), no DST. Same pattern as the reference
// SkiSchool bot's Georgia helpers, just a different fixed offset.

const BALI_OFFSET_MINUTES = 8 * 60;

// "YYYY-MM-DD HH:MM:SS" for the current moment in Bali wall-clock time,
// optionally shifted by offsetMinutes (e.g. +180 for "3 hours from now").
function nowBaliString(offsetMinutes = 0) {
  const shifted = new Date(Date.now() + (BALI_OFFSET_MINUTES + offsetMinutes) * 60000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

function nowBaliDate(offsetMinutes = 0) {
  return new Date(Date.now() + offsetMinutes * 60000);
}

// Converts a naive Bali local date+time string into a real UTC Date.
function baliToUtcDate(dateStr, timeStr) {
  const [y, mo, da] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const asIfUtc = Date.UTC(y, mo - 1, da, hh, mm, 0);
  return new Date(asIfUtc - BALI_OFFSET_MINUTES * 60000);
}

module.exports = { nowBaliString, nowBaliDate, baliToUtcDate, BALI_OFFSET_MINUTES };
