/**
 * Veo → Cockpit forwarder (Google Apps Script).
 *
 * Runs on a time trigger against the Gmail account that receives Veo emails.
 * For each FINAL "ready to watch" email from service@veo.co, it extracts the
 * "Watch your video" link and POSTs {subject, videoUrl, from, receivedAt,
 * messageId} to Cockpit's /api/veo/inbound, then labels the thread so it's
 * never processed twice. Cockpit does the parsing, matching, and posting.
 *
 * WHY Apps Script (vs. an inbound-parse webhook):
 *   - Zero new infra: no third-party parse vendor, no MX/DNS change, no
 *     mail-forwarding rules. It runs on the mailbox that already gets the
 *     mail.
 *   - Reads Gmail directly, so it can pull the exact href out of the HTML
 *     body (the constraint: extract, never reconstruct).
 *   - Idempotent twice over: a Gmail label here + the recording-id unique
 *     index on the Cockpit side.
 *
 * SETUP
 *   1. script.google.com → New project → paste this file.
 *   2. Project Settings → Script properties, add:
 *        COCKPIT_ENDPOINT = https://matchday-clubhouse.vercel.app/api/veo/inbound
 *        VEO_SHARED_SECRET = <same value as VEO_INBOUND_SECRET in Vercel>
 *   3. Run `installTrigger` once (authorize Gmail access when prompted).
 *   4. (Optional) Run `processVeoEmails` manually to backfill / test.
 *
 * The trigger runs every 15 minutes. Veo's final email is not time-critical,
 * so a short lag is fine.
 */

var PROCESSED_LABEL = 'veo-posted';
// Only the FINAL email. Gmail's search can't distinguish it from the preview
// perfectly, so we also re-check the subject in code and Cockpit gates again.
var SEARCH_QUERY =
  'from:service@veo.co subject:"is ready to watch" -label:' +
  PROCESSED_LABEL +
  ' newer_than:14d';

function installTrigger() {
  // Remove any existing triggers for this function first (idempotent setup).
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processVeoEmails') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('processVeoEmails')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('Trigger installed: processVeoEmails every 15 minutes.');
}

function processVeoEmails() {
  var props = PropertiesService.getScriptProperties();
  var endpoint = props.getProperty('COCKPIT_ENDPOINT');
  var secret = props.getProperty('VEO_SHARED_SECRET');
  if (!endpoint || !secret) {
    Logger.log('Missing COCKPIT_ENDPOINT or VEO_SHARED_SECRET script property.');
    return;
  }

  var label = getOrCreateLabel(PROCESSED_LABEL);
  var threads = GmailApp.search(SEARCH_QUERY, 0, 50);

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    var messages = thread.getMessages();
    var handledThisThread = false;

    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var subject = msg.getSubject() || '';

      // Skip preview / early-access emails; only forward the final one.
      if (!/is ready to watch/i.test(subject)) continue;
      if (/is processing|early access/i.test(subject)) continue;

      var html = msg.getBody() || '';
      var videoUrl = extractVeoLink(html);
      if (!videoUrl) {
        Logger.log('No Veo link found in: ' + subject);
        continue;
      }

      var payload = {
        subject: subject,
        videoUrl: videoUrl,
        from: msg.getFrom(),
        receivedAt: msg.getDate().toISOString(),
        messageId: msg.getId(),
      };

      var ok = postToCockpit(endpoint, secret, payload);
      if (ok) handledThisThread = true;
    }

    // Label the thread only if at least one final email posted OK, so a
    // transient failure is retried on the next run.
    if (handledThisThread) thread.addLabel(label);
  }
}

/**
 * Pull the shareable "Watch your video" link out of the email HTML. We take
 * the first https://app.veo.co/matches/... URL — that IS the watch href
 * (extracting it, not reconstructing it).
 */
function extractVeoLink(html) {
  var m = html.match(/https?:\/\/app\.veo\.co\/matches\/[^\s"'<>)]+/i);
  return m ? m[0] : null;
}

function postToCockpit(endpoint, secret, payload) {
  try {
    var res = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    Logger.log('POST ' + code + ' — ' + res.getContentText());
    // 2xx = accepted (posted, queued, deduped, or ignored). Anything else is
    // a real failure → leave the thread unlabeled so it retries.
    return code >= 200 && code < 300;
  } catch (e) {
    Logger.log('POST error: ' + e);
    return false;
  }
}

function getOrCreateLabel(name) {
  var label = GmailApp.getUserLabelByName(name);
  return label ? label : GmailApp.createLabel(name);
}
