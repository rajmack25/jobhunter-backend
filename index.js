const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');

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
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
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
app.listen(process.env.PORT || 3001);
