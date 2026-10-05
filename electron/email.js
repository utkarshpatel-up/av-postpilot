const nodemailer = require('nodemailer');

// Accept plain addresses only; no display names or header syntax in settings.
const validAddress = (value) => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(String(value || ''));
function recipients(value) {
  const list = (Array.isArray(value) ? value : String(value || '').split(/[,;\n]+/))
    .map((v) => String(v).trim()).filter(Boolean);
  if (!list.length) throw new Error('Add at least one email recipient');
  if (list.some((v) => !validAddress(v))) throw new Error('Use plain email addresses, separated by commas');
  return [...new Set(list.map((v) => v.toLowerCase()))];
}

function emailOptions(settings, password) {
  const user = String(settings.user || '').trim();
  if (!validAddress(user)) throw new Error('Enter your Gmail sender address');
  if (!password) throw new Error('Save a Google App Password first');
  return {
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user, pass: password.replace(/\s/g, '') },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true,
  };
}

async function sendEmail(settings, password, to, text, createTransport = nodemailer.createTransport) {
  const transport = createTransport(emailOptions(settings, password));
  try {
    const result = await transport.sendMail({
      from: { name: 'AV PostPilot', address: settings.user.trim() },
      to: recipients([to]),
      subject: `[AV PostPilot] ${text.split('\n')[0].slice(0, 160)}`,
      text,
    });
    if (!result.accepted?.length || result.rejected?.length) throw new Error('Email server did not accept the recipient');
    return result;
  } finally { transport.close(); }
}

module.exports = { sendEmail, recipients, validAddress, emailOptions };
