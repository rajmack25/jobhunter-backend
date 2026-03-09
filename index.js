const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const MY_PHONE = process.env.MY_PHONE;
const MY_EMAIL = process.env.MY_EMAIL;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const CV_SUMMARY = `
Timothy Jaravani - Procurement & Operations Professional
Email: jaraztimothy@gmail.com | Phone: +263 785 010 425 | Harare, Zimbabwe

EXPERIENCE:
- Procurement Manager, Foodmakers (Pty) Ltd, Johannesburg (Feb 2025 - Dec 2025)
  Managed 600+ SKUs, 200+ suppliers, improved on-time delivery by 18%, reduced stock discrepancies by 18%
- Operations Manager, Valley Farm Secrets, Harare (Jan 2022 - Dec 2024)
  Managed 3 distribution branches, improved cost margins by 10%, cross-border sourcing
- Founder & Manager, Burger Kitchen (Sep 2022 - Dec 2024)
- SEO Content Writer, Reactive IT

EDUCATION:
- Bachelor of Commerce in Management Sciences, North West University (2022)

CERTIFICATIONS:
- HubSpot Digital Marketing Certification
- IBM Mathematical Optimization for Business Problems
- Nestlé NextGen Digital & AI Skills Certificate
- Junior Bookkeeper & Business Mathematics Certificate
- Procurement & Logistics Certificate (DisasterReady/Mercy Corps)
- Diploma in Project Management (in progress)

SKILLS:
Procurement & Supplier Negotiation, Inventory Management, Logistics Coordination,
Supply Chain Operations, Operational Efficiency, Advanced Excel, ERP Systems (Sage/Business Central),
Microsoft Office, Stakeholder Communication, Team Coordination
`;

const JOB_KEYWORDS = [
  'vacancy', 'hiring', 'job', 'opportunity', 'apply',
  'position', 'recruitment', 'career', 'CV', 'resume',
  'procurement', 'operations', 'logistics', 'supply chain',
  'manager', 'officer', 'coordinator', 'administrator',
  'wanted', 'urgent', 'salary', 'experience', 'qualification'
];

let qrCodeData = null;
let isReady = false;
const jobMessages = [];
const pendingApplications = {};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

let chromiumPath = '';
try {
  chromiumPath = execSync('which chromium || which chromium-browser || which google-chrome || find /nix -name "chromium" 2>/dev/null | head -1').toString().trim();
} catch(e) {}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process'],
    executablePath: chromiumPath || undefined
  }
});

function getAttachments() {
  const attachments = [];
  const cvPath = path.join(__dirname, 'cv.pdf');
  const clPath = path.join(__dirname, 'coverletter.docx');
  const certPath = path.join(__dirname, 'certificates.pdf');
  if (fs.existsSync(cvPath)) attachments.push({ filename: 'Timothy_Jaravani_CV.pdf', path: cvPath });
  if (fs.existsSync(clPath)) attachments.push({ filename: 'Timothy_Jaravani_Cover_Letter.docx', path: clPath });
  if (fs.existsSync(certPath)) attachments.push({ filename: 'Timothy_Jaravani_Certificates.pdf', path: certPath });
  console.log('Attachments found:', attachments.map(a => a.filename));
  return attachments;
}

function isJobMessage(text) {
  const lower = text.toLowerCase();
  return JOB_KEYWORDS.some(k => lower.includes(k));
}

function addJobMessage(msg, chatName) {
  const id = msg.id._serialized || msg.id;
  if (jobMessages.find(j => j.id === id)) return;
  if (isJobMessage(msg.body)) {
    const job = {
      id,
      body: msg.body,
      from: msg.from,
      time: new Date(msg.timestamp * 1000).toISOString(),
      chatName: chatName || msg._data?.notifyName || msg.from,
      notified: false
    };
    jobMessages.unshift(job);
    if (jobMessages.length > 200) jobMessages.pop();
    if (isReady && !msg._data?.isForwarded) {
      processNewJob(job);
    }
  }
}

async function generateCoverLetter(jobText) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Write a professional cover letter for Timothy Jaravani applying for this job.

Job posting:
${jobText}

Timothy's background:
${CV_SUMMARY}

Write a concise, professional cover letter (3 paragraphs max) tailored specifically to this job.
Start with "Dear Hiring Manager," and end with "Yours faithfully, Timothy Jaravani".
Make it specific to the job requirements. Do not use placeholders.`
        }]
      })
    });
    const data = await response.json();
    return data.content?.[0]?.text || null;
  } catch(e) {
    console.log('Cover letter generation error:', e.message);
    return null;
  }
}

function extractJobContact(jobText) {
  const emailMatch = jobText.match(/[\w.-]+@[\w.-]+\.\w+/);
  const phoneMatch = jobText.match(/(\+?2637\d{8}|07\d{8}|\+27\d{9})/);
  return {
    email: emailMatch ? emailMatch[0] : null,
    phone: phoneMatch ? phoneMatch[0] : null
  };
}

async function processNewJob(job) {
  if (job.notified) return;
  job.notified = true;
  console.log('Processing new job:', job.chatName);

  const coverLetter = await generateCoverLetter(job.body);
  const contact = extractJobContact(job.body);

  const appId = Date.now().toString();
  pendingApplications[appId] = { job, coverLetter, contact, status: 'pending' };

  const preview = job.body.slice(0, 300);
  const approveMsg = `
🤖 *JobHunter AI — New Job Found!*

📋 *Source:* ${job.chatName}
⏰ *Time:* ${new Date(job.time).toLocaleString('en-ZW')}

📝 *Job Preview:*
${preview}${job.body.length > 300 ? '...' : ''}

✉️ *Contact found:* ${contact.email || contact.phone || 'None detected'}

📄 *Cover Letter Preview:*
${coverLetter ? coverLetter.slice(0, 200) + '...' : 'Could not generate cover letter'}

---
Reply *APPROVE_${appId}* to send application
Reply *SKIP_${appId}* to ignore this job
`;

  try {
    await client.sendMessage(`${MY_PHONE}@c.us`, approveMsg);
    console.log('WhatsApp notification sent');
  } catch(e) {
    console.log('WhatsApp notify error:', e.message);
  }

  try {
    await transporter.sendMail({
      from: GMAIL_USER,
      to: MY_EMAIL,
      subject: `🤖 JobHunter: New Job from ${job.chatName} — Approve?`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#25D366;">🤖 JobHunter AI — New Job Found!</h2>
          <p><strong>Source:</strong> ${job.chatName}</p>
          <p><strong>Time:</strong> ${new Date(job.time).toLocaleString('en-ZW')}</p>
          <p><strong>Contact:</strong> ${contact.email || contact.phone || 'None detected'}</p>
          <h3>Job Posting:</h3>
          <div style="background:#f5f5f5;padding:15px;border-radius:8px;white-space:pre-wrap;">${job.body}</div>
          <h3>AI Generated Cover Letter:</h3>
          <div style="background:#e8f5e9;padding:15px;border-radius:8px;white-space:pre-wrap;">${coverLetter || 'Could not generate'}</div>
          <div style="margin-top:20px;text-align:center;">
            <a href="https://jobhunter-backend-production.up.railway.app/approve/${appId}"
               style="background:#25D366;color:white;padding:12px 30px;border-radius:8px;text-decoration:none;font-weight:bold;margin-right:10px;">
              ✅ APPROVE & SEND
            </a>
            <a href="https://jobhunter-backend-production.up.railway.app/skip/${appId}"
               style="background:#ff4444;color:white;padding:12px 30px;border-radius:8px;text-decoration:none;font-weight:bold;">
              ❌ SKIP
            </a>
          </div>
          <p style="color:#999;font-size:12px;margin-top:20px;">Or reply APPROVE_${appId} / SKIP_${appId} on WhatsApp</p>
        </div>
      `
    });
    console.log('Email notification sent');
  } catch(e) {
    console.log('Email notify error:', e.message);
  }
}

async function sendApplication(appId) {
  const pendingApp = pendingApplications[appId];
  if (!pendingApp || pendingApp.status !== 'pending') return false;
  pendingApp.status = 'sent';

  const { job, coverLetter, contact } = pendingApp;
  const attachments = getAttachments();

  if (contact.email) {
    try {
      await transporter.sendMail({
        from: `Timothy Jaravani <${GMAIL_USER}>`,
        to: contact.email,
        subject: `Job Application — Timothy Jaravani`,
        text: coverLetter || `Dear Hiring Manager,\n\nI am writing to apply for the advertised position.\n\nYours faithfully,\nTimothy Jaravani\n+263 785 010 425`,
        attachments
      });
      console.log('Application email sent to:', contact.email);
    } catch(e) {
      console.log('Application email error:', e.message);
    }
  }

  if (contact.phone) {
    try {
      const phone = contact.phone.replace(/\D/g,'').replace(/^0/,'263');
      const msg = coverLetter
        ? coverLetter + '\n\n_CV available on request. Contact: jaraztimothy@gmail.com_'
        : `Dear Hiring Manager,\n\nI am Timothy Jaravani and I am interested in the advertised position. I have 3+ years experience in procurement and operations.\n\nPlease contact me:\nEmail: jaraztimothy@gmail.com\nPhone: +263 785 010 425`;
      await client.sendMessage(`${phone}@c.us`, msg);
      console.log('WhatsApp application sent to:', phone);
    } catch(e) {
      console.log('WhatsApp application error:', e.message);
    }
  }

  try {
    await client.sendMessage(`${MY_PHONE}@c.us`,
      `✅ *Application Sent!*\n\nJob from: ${job.chatName}\n${contact.email ? '📧 Email sent to: ' + contact.email : ''}${contact.phone ? '\n📱 WhatsApp sent to: ' + contact.phone : ''}\n\n📎 Attachments sent: CV, Cover Letter, Certificates\n\nGood luck Timothy! 🤞`
    );
  } catch(e) {}

  return true;
}

client.on('message', async (msg) => {
  if (msg.from === `${MY_PHONE}@c.us`) {
    const text = msg.body.trim().toUpperCase();
    if (text.startsWith('APPROVE_')) {
      const appId = text.replace('APPROVE_', '');
      const success = await sendApplication(appId);
      await msg.reply(success ? '✅ Application sent with CV, Cover Letter & Certificates!' : '❌ Application not found or already processed.');
    } else if (text.startsWith('SKIP_')) {
      const appId = text.replace('SKIP_', '');
      if (pendingApplications[appId]) {
        pendingApplications[appId].status = 'skipped';
        await msg.reply('⏭️ Job skipped.');
      }
    }
    return;
  }

  if (!msg.body || msg.body.length < 10) return;
  try {
    const chat = await msg.getChat();
    addJobMessage(msg, chat.name);
  } catch(e) {
    addJobMessage(msg, msg.from);
  }
});

client.on('qr', async (qr) => {
  qrCodeData = await qrcode.toDataURL(qr);
  console.log('QR Code ready');
});

client.on('ready', async () => {
  isReady = true;
  console.log('WhatsApp connected! Loading history...');
  try {
    const chats = await client.getChats();
    for (const chat of chats) {
      try {
        const messages = await chat.fetchMessages({ limit: 50 });
        for (const msg of messages) {
          if (msg.body && msg.body.length > 20) {
            addJobMessage(msg, chat.name);
          }
        }
      } catch(e) {}
    }
    console.log(`History loaded. Found ${jobMessages.length} job messages.`);
  } catch(e) {
    console.log('History error:', e.message);
  }
});

app.get('/approve/:appId', async (req, res) => {
  const success = await sendApplication(req.params.appId);
  res.send(`<html><body style="font-family:Arial;text-align:center;padding:50px;">
    ${success
      ? '<h1 style="color:green;">✅ Application Sent!</h1><p>CV, Cover Letter & Certificates delivered successfully.</p>'
      : '<h1 style="color:red;">❌ Already Processed</h1><p>This application was already sent or skipped.</p>'}
    </body></html>`);
});

app.get('/skip/:appId', (req, res) => {
  if (pendingApplications[req.params.appId]) {
    pendingApplications[req.params.appId].status = 'skipped';
  }
  res.send(`<html><body style="font-family:Arial;text-align:center;padding:50px;">
    <h1 style="color:orange;">⏭️ Job Skipped</h1><p>This job has been skipped.</p>
    </body></html>`);
});

app.get('/status', (req, res) => {
  res.json({ ready: isReady, qr: qrCodeData, jobCount: jobMessages.length });
});

app.get('/jobs', (req, res) => res.json(jobMessages));
app.get('/pending', (req, res) => res.json(pendingApplications));

app.get('/qr', (req, res) => {
  if (isReady) {
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0;">
      <h1 style="color:green;">✅ WhatsApp Connected!</h1>
      <p>Jobs found: ${jobMessages.length} | Pending: ${Object.keys(pendingApplications).length}</p>
      </body></html>`);
  } else if (qrCodeData) {
    res.send(`<html><head><meta http-equiv="refresh" content="30"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0;">
      <h1>📱 Scan with WhatsApp</h1>
      <img src="${qrCodeData}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:12px;"/>
      </body></html>`);
  } else {
    res.send(`<html><head><meta http-equiv="refresh" content="3"></head>
      <body style="text-align:center;padding:40px;"><h1>⏳ Loading...</h1></body></html>`);
  }
});

client.initialize();
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
