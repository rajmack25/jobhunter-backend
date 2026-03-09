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

client.initialize();
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

