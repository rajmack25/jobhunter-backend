const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const JOB_KEYWORDS = [
  'vacancy', 'hiring', 'job', 'opportunity', 'apply',
  'position', 'recruitment', 'career', 'CV', 'resume',
  'procurement', 'operations', 'logistics', 'supply chain',
  'manager', 'officer', 'coordinator', 'administrator'
];

let qrCodeData = null;
let isReady = false;
const jobMessages = [];

let chromiumPath = '';
try {
  chromiumPath = execSync('which chromium || which chromium-browser || which google-chrome || find /nix -name "chromium" 2>/dev/null | head -1').toString().trim();
  console.log('Found chromium at:', chromiumPath);
} catch(e) {
  console.log('Chromium search error:', e.message);
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process'
    ],
    executablePath: chromiumPath || undefined
  }
});

client.on('qr', async (qr) => {
  qrCodeData = await qrcode.toDataURL(qr);
  console.log('QR Code ready - scan it in the app');
});

client.on('ready', () => {
  isReady = true;
  console.log('WhatsApp connected!');
});

client.on('message', (msg) => {
  const text = msg.body.toLowerCase();
  const isJobPost = JOB_KEYWORDS.some(k => text.includes(k));
  if (isJobPost) {
    jobMessages.unshift({
      id: msg.id._serialized,
      body: msg.body,
      from: msg.from,
      time: new Date(msg.timestamp * 1000).toISOString(),
      chatName: msg._data.notifyName || msg.from
    });
    if (jobMessages.length > 100) jobMessages.pop();
  }
});

app.get('/status', (req, res) => {
  res.json({ ready: isReady, qr: qrCodeData });
});

app.get('/jobs', (req, res) => {
  res.json(jobMessages);
});

// QR Code page - easy to scan!
app.get('/qr', (req, res) => {
  if (isReady) {
    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0;">
          <h1 style="color:green;">✅ WhatsApp Connected!</h1>
          <p>Your JobHunter AI is ready and listening for job messages.</p>
        </body>
      </html>
    `);
  } else if (qrCodeData) {
    res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="30">
        </head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0;">
          <h1>📱 Scan with WhatsApp</h1>
          <p>Open WhatsApp → Three dots → Linked Devices → Link a Device</p>
          <img src="${qrCodeData}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:12px;"/>
          <p style="color:gray;font-size:14px;">Page auto-refreshes every 30 seconds with a new code</p>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <head><meta http-equiv="refresh" content="3"></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0;">
          <h1>⏳ Loading QR Code...</h1>
          <p>Please wait, this page will refresh automatically.</p>
        </body>
      </html>
    `);
  }
});

client.initialize();
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
