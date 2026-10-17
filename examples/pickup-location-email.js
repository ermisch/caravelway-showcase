// Excerpt (adapted) from CaravelWay: how a customer email picks its brand, sender and pickup-location content.
// The database and mail transports are replaced by a plain `settings` object; identifiers are renamed.
'use strict';

// One booking can come from any of several brand websites and be collected at any of several
// stations. Staff edit, per (brand, station): the pickup instructions, the images and files to
// include, and an on/off switch for automated email. Everything else falls back to the brand,
// then to the platform default, so a half-configured brand still sends a correct email.

const sameStation = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// The booking's own brand, else the platform's default brand. Never throws.
function brandFor(booking, settings) {
  const id = booking.brandId ?? settings.defaultBrandId;
  return settings.brands.find((b) => b.id === id) || null;
}

function stationRow(booking, settings) {
  const brand = brandFor(booking, settings);
  if (!brand || !booking.pickupStation) return null;
  return settings.stationEmails.find((r) => r.brandId === brand.id && sameStation(r.station, booking.pickupStation)) || null;
}

// The on/off switch fails OPEN. Only an explicit "off" mutes a station; a missing row, a legacy
// row with no value, or a lookup error all mean "send". (Treating null as 0 would silently mute a
// station, which is exactly the bug a reviewer caught in the original.)
function automatedEmailOn(booking, settings) {
  try {
    const row = stationRow(booking, settings);
    return !(row && (row.emailOn === 0 || row.emailOn === false));
  } catch {
    return true;
  }
}

// Brand-wide assets plus this station's own. Inline images go in the body; attachments are
// capped by count and total size so a provider never rejects the message, and a file that has
// gone missing on disk is skipped rather than breaking the send.
function assetsFor(booking, settings, { maxFiles = 10, maxBytes = 15 * 1024 * 1024, fileExists = () => true } = {}) {
  const brand = brandFor(booking, settings);
  const out = { inline: [], attachments: [] };
  if (!brand) return out;
  let bytes = 0;
  for (const a of settings.assets) {
    if (a.brandId !== brand.id) continue;
    if (a.station != null && !sameStation(a.station, booking.pickupStation)) continue;
    if (a.role === 'inline') { out.inline.push(a); continue; }
    if (out.attachments.length >= maxFiles || bytes + a.sizeBytes > maxBytes || !fileExists(a)) continue;
    out.attachments.push(a);
    bytes += a.sizeBytes;
  }
  return out;
}

// Who the email is from, and where a reply goes.
//  From address: the brand's own mailbox if it is set up, else the brand's address only if the
//  sending provider has verified that domain, else the platform sender. Each step exists because
//  sending "as" an unverified domain is rejected, and a rejection would re-fire on every pass.
//  Reply-To: the brand's explicit reply-to, else its own address, else the platform default, so a
//  customer's reply reaches the brand they booked with.
function senderFor(booking, settings, { mailboxFor = () => null, providerVerified = () => false } = {}) {
  const d = settings.platformDefaults;
  const brand = brandFor(booking, settings);
  const name = (brand && (brand.fromName || brand.name)) || d.name;
  const brandAddress = brand && brand.ownAddress ? brand.ownAddress.trim() : '';
  const fromAddress = (brand && mailboxFor(brand)) || (brandAddress && providerVerified(brandAddress) ? brandAddress : d.fromAddress);
  const replyTo = (brand && brand.replyTo) || brandAddress || d.replyTo;
  // A comma or angle bracket in a display name breaks the From header; strip them.
  const safeName = String(name).replace(/[<>"\r\n,]/g, ' ').trim() || d.name;
  return { fromHeader: `${safeName} <${fromAddress}>`, replyTo, phone: (brand && brand.phone) || d.phone };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The "Your pickup at ..." block. Empty when the station has neither instructions nor images,
// so an unconfigured station adds nothing rather than an empty box.
function pickupBlockHtml(booking, settings) {
  const row = stationRow(booking, settings);
  const text = row && row.instructions ? row.instructions.trim() : '';
  const imgs = assetsFor(booking, settings).inline.map((a) => `<img src="${esc(a.url)}" alt="">`).join('');
  if (!text && !imgs) return '';
  const body = text ? `<p>${esc(text).replace(/\n/g, '<br>')}</p>` : '';
  const station = (row && row.station) || String(booking.pickupStation || '').trim();
  return `<div class="pickup"><p><strong>Your pickup at ${esc(station)}</strong></p>${body}${imgs}</div>`;
}

module.exports = { brandFor, automatedEmailOn, assetsFor, senderFor, pickupBlockHtml };

// Minimal demonstration: node pickup-location-email.js
if (require.main === module) {
  const settings = {
    defaultBrandId: 1,
    platformDefaults: { name: 'Platform', fromAddress: 'bookings@platform.example', replyTo: 'help@platform.example', phone: '+00 000 000' },
    brands: [
      { id: 1, name: 'Brand A' },
      { id: 2, name: 'Brand B', fromName: 'Brand B Rentals', ownAddress: 'hello@brand-b.example' },
    ],
    stationEmails: [
      { brandId: 2, station: 'Airport', instructions: 'Meet us at the arrivals exit.\nLook for the yellow sign.' },
      { brandId: 2, station: 'Harbour', emailOn: 0 },
    ],
    assets: [
      { brandId: 2, station: null, role: 'attachment', name: 'terms.pdf', sizeBytes: 200000 },
      { brandId: 2, station: 'Airport', role: 'inline', url: 'https://cdn.example/airport-map.png' },
    ],
  };
  const airport = { brandId: 2, pickupStation: ' airport ' };
  console.log(automatedEmailOn(airport, settings), automatedEmailOn({ brandId: 2, pickupStation: 'Harbour' }, settings));
  console.log(senderFor(airport, settings));
  console.log(assetsFor(airport, settings).attachments.map((a) => a.name));
  console.log(pickupBlockHtml(airport, settings));
}
