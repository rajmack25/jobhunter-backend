const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const MY_PHONE = process.env.MY_PHONE;
const MY_EMAIL = process.env.MY_EMAIL;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SERP_KEY = process.env.SERP_API_KEY;

// Only watch this group
const TARGET_GROUP = 'Jobs 2026';

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

// Skills Timothy has - job must match at least one
const MY_SKILLS = [
  'procurement', 'purchasing', 'supply chain', 'logistics', 'operations',
  'inventory', 'warehouse', 'stores', 'admin', 'administrator',
  'coordinator', 'manager', 'officer', 'clerk', 'bookkeeper',
  'finance', 'accounts', 'marketing', 'project management'
];

// Must have these to confirm it's a real job post
const JOB_CONFIRM_KEYWORDS = [
  'vacancy', 'vacancies', 'hiring', 'we are hiring', 'now hiring',
  'job opportunity', 'job opening', 'applications invited',
  'apply now', 'apply before', 'apply by', 'apply to',
  'recruitment', 'we are recruiting', 'position available',
  'requirements', 'qualifications', 'key responsibilities',
  'send cv', 'send your cv', 'email cv', 'submit cv',
  'closing date', 'deadline', 'salary', 'remuneration'
];

let qrCodeData = null;
let isReady = false;
const jobMessages = [];
const scrapedJobs = [];
const pendingApplications = {};
const seenJobUrls = new Set();
const seenMessageIds = new Set();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

let chromiumPath = '';
try {
  chromiumPath = execSync('which chromium || which chromium-browser || which google-chrome || find /nix -name "chromium" 2>/dev/null | head -1').toString().trim();
} catch(e) {}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
  puppeteer: {
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process'],
    executablePath: chromiumPath || undefined
  }
});

function getAttachments() {
  const attachments = [];
  const files = [
    { name: 'Timothy_Jaravani_CV.pdf', file: 'cv.pdf' },
    { name: 'Timothy_Jaravani_Cover_Letter.docx', file: 'coverletter.docx' },
    { name: 'Timothy_Jaravani_Certificates.pdf', file: 'certificates.pdf' }
  ];
  for (const f of files) {
    const p = path.join(__dirname, f.file);
    if (fs.existsSync(p)) attachments.push({ filename: f.name, path: p });
  }
  return attachments;
}

function isJobPost(text) {
  if (!text || text.length < 50) return false;
  if (text.includes('JobHunter AI') || text.includes('APPROVE_') || text.includes('SKIP_')) return false;
  const lower = text.toLowerCase();

  // Must have at least 1 job confirmation keyword
  const hasJobKeyword = JOB_CONFIRM_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
  if (!hasJobKeyword) return false;

  // Must match at least 1 of Timothy's skills
  const matchesSkills = MY_SKILLS.some(skill => lower.includes(skill));
  if (!matchesSkills) {
    console.log('Job found but skills dont match — skipping');
    return false;
  }

  return true;
}

function extractJobContact(jobText) {
  const emailMatch = jobText.match(/[\w.-]+@[\w.-]+\.\w+/);
  const phoneMatch = jobText.match(/(\+?2637\d{8}|07\d{8}|\+27\d{9})/);
  return {
    email: emailMatch ? emailMatch[0] : null,
    phone: phoneMatch ? phoneMatch[0] : null
  };
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
    console.log('Cover letter error:', e.message);
    return null;
  }
}

async function processNewJob(job) {
  if (job.notified) return;
  job.notified = true;
  console.log('✅ Relevant job found from:', job.chatName || job.source);

  const coverLetter = await generateCoverLetter(job.body);
  const contact = extractJobContact(job.body);

  const appId = Date.now().toString();
  pendingApplications[appId] = { job, coverLetter, contact, status: 'pending' };

  const preview = job.body.slice(0, 400);
  const source = job.chatName || job.source || 'Jobs 2026';
  const link = job.link ? `\n🔗 *Link:* ${job.link}` : '';

  const approveMsg = `🤖 *JobHunter AI — New Job Found!*

📋 *Source:* ${source}${link}
⏰ *Time:* ${new Date(job.time).toLocaleString('en-ZW')}

📝 *Job Preview:*
${preview}${job.body.length > 400 ? '...' : ''}

✉️ *Contact:* ${contact.email || contact.phone || 'None detected'}

📄 *Cover Letter Preview:*
${coverLetter ? coverLetter.slice(0, 300) + '...' : 'Could not generate'}

---
Reply *APPROVE* to send application
Reply *DECLINE* to skip this job`;

  try {
    await client.sendMessage(`${MY_PHONE}@c.us`, approveMsg);
    console.log('WhatsApp notification sent to Timothy');
  } catch(e) {
    console.log('WA notify error:', e.message);
  }

  try {
    await transporter.sendMail({
      from: GMAIL_USER,
      to: MY_EMAIL,
      subject: `🤖 JobHunter: New Job from ${source} — Approve?`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#25D366;">🤖 JobHunter AI — New Job Found!</h2>
          <p><strong>Source:</strong> ${source}</p>
          ${job.link ? `<p><strong>Link:</strong> <a href="${job.link}">${job.link}</a></p>` : ''}
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
          <p style="color:#999;font-size:12px;margin-top:20px;">Or reply APPROVE / DECLINE on WhatsApp</p>
        </div>`
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
  const source = job.chatName || job.source || 'Jobs 2026';

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
        : `Dear Hiring Manager,\n\nI am Timothy Jaravani, interested in the advertised position. 3+ years in procurement and operations.\n\nEmail: jaraztimothy@gmail.com\nPhone: +263 785 010 425`;
      await client.sendMessage(`${phone}@c.us`, msg);
      console.log('WA application sent to:', phone);
    } catch(e) {
      console.log('WA application error:', e.message);
    }
  }

  try {
    await client.sendMessage(`${MY_PHONE}@c.us`,
      `✅ *Application Sent!*\n\nJob from: ${source}\n${contact.email ? '📧 Email: ' + contact.email : ''}${contact.phone ? '\n📱 WhatsApp: ' + contact.phone : ''}\n📎 CV + Cover Letter + Certificates attached\n\nGood luck Timothy! 🤞`
    );
  } catch(e) {}

  return true;
}

async function scrapeJobSites() {
  if (!SERP_KEY) { console.log('No SERP key'); return; }
  console.log('Scraping job sites...');

  const queries = [
    'procurement manager Zimbabwe',
    'operations manager Zimbabwe',
    'logistics coordinator Zimbabwe',
    'supply chain Zimbabwe',
    'administrator Zimbabwe',
    'stores clerk Zimbabwe',
    'finance officer Zimbabwe'
  ];

  const JOB_SITES = [
    'vacancymail.co.zw', 'classifieds.co.zw', 'zimbabwejobs.co.zw',
    'alljobszw.com', 'ihararejobs.com', 'careers.co.zw',
    'jobszimbabwe.net', 'applynow.co.zw', 'zimngojobs.co.zw',
    'reliefweb.int', 'ngojobszimbabwe.com',
    'jobboard.co.zw', 'cvpeopleafrica.com', 'prostaff.co.zw'
  ];

  for (const site of JOB_SITES) {
    for (const query of queries.slice(0, 3)) {
      try {
        // Remove date filter so we get more results
        const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query + ' site:' + site)}&api_key=${SERP_KEY}&num=5`;
        const res = await axios.get(url, { timeout: 15000 });
        const results = res.data.organic_results || [];
        console.log(`${site} - ${query}: ${results.length} results`);

        for (const result of results) {
          if (seenJobUrls.has(result.link)) continue;
          seenJobUrls.add(result.link);

          const jobText = `${result.title}\n\nVacancy: ${result.title}\nApply now: ${result.link}\n\n${result.snippet || ''}\n\nRequirements: See full listing\nClosing date: See listing\nSource: ${site}`;

          if (isJobPost(jobText)) {
            const job = {
              id: result.link,
              body: jobText,
              from: site,
              source: site,
              link: result.link,
              time: new Date().toISOString(),
              chatName: site,
              notified: false
            };
            scrapedJobs.unshift(job);
            if (scrapedJobs.length > 500) scrapedJobs.pop();
            await processNewJob(job);
            await new Promise(r => setTimeout(r, 1500));
          }
        }
      } catch(e) {
        console.log(`Scrape error for ${site}:`, e.message);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`Scraping done. Total scraped: ${scrapedJobs.length}`);
}

function addJobMessage(msg, chatName) {
  const id = msg.id._serialized || msg.id;
  if (seenMessageIds.has(id)) return;
  seenMessageIds.add(id);
  if (jobMessages.find(j => j.id === id)) return;

  // Only process messages from Jobs 2026 group
  if (!chatName || !chatName.includes(TARGET_GROUP)) return;

  // Skip own messages
  if (msg.from === `${MY_PHONE}@c.us`) return;

  if (!msg.body || msg.body.length < 30) return;
  if (!isJobPost(msg.body)) {
    console.log(`Message from ${chatName} — not a relevant job, skipping`);
    return;
  }

  const job = {
    id,
    body: msg.body,
    from: msg.from,
    time: new Date(msg.timestamp * 1000).toISOString(),
    chatName: chatName,
    notified: false
  };
  jobMessages.unshift(job);
  if (jobMessages.length > 200) jobMessages.pop();
  console.log(`✅ Relevant job detected in ${chatName}!`);
  if (isReady) processNewJob(job);
}

client.on('message', async (msg) => {
  // Handle APPROVE/DECLINE from Timothy
  if (msg.from === `${MY_PHONE}@c.us`) {
    const text = msg.body.trim().toUpperCase();

    if (text === 'APPROVE' || text === 'YES' || text === 'SEND') {
      const pendingId = Object.keys(pendingApplications)
        .reverse()
        .find(id => pendingApplications[id].status === 'pending');
      if (pendingId) {
        const success = await sendApplication(pendingId);
        await msg.reply(success ? '✅ Application sent with CV, Cover Letter & Certificates!' : '❌ Failed to send.');
      } else {
        await msg.reply('❌ No pending applications found.');
      }

    } else if (text === 'DECLINE' || text === 'SKIP' || text === 'NO') {
      const pendingId = Object.keys(pendingApplications)
        .reverse()
        .find(id => pendingApplications[id].status === 'pending');
      if (pendingId) {
        pendingApplications[pendingId].status = 'skipped';
        await msg.reply('⏭️ Job skipped. Reply APPROVE or DECLINE for the next one.');
      } else {
        await msg.reply('❌ No pending applications found.');
      }

    } else if (text.startsWith('APPROVE_')) {
      const appId = text.replace('APPROVE_', '');
      const success = await sendApplication(appId);
      await msg.reply(success ? '✅ Sent!' : '❌ Not found.');

    } else if (text.startsWith('SKIP_')) {
      const appId = text.replace('SKIP_', '');
      if (pendingApplications[appId]) {
        pendingApplications[appId].status = 'skipped';
        await msg.reply('⏭️ Skipped.');
      }
    }
    return;
  }

  // Only process messages from Jobs 2026 group
  if (!msg.body || msg.body.length < 30) return;
  try {
    const chat = await msg.getChat();
    if (chat.name === TARGET_GROUP) {
      console.log(`New message in ${TARGET_GROUP} — checking if job...`);
      addJobMessage(msg, chat.name);
    }
  } catch(e) {
    console.log('Message error:', e.message);
  }
});

client.on('qr', async (qr) => {
  qrCodeData = await qrcode.toDataURL(qr);
  console.log('QR ready');
});

client.on('ready', async () => {
  isReady = true;
  console.log('WhatsApp connected! Looking for Jobs 2026 group...');
  try {
    const chats = await client.getChats();
    console.log(`Found ${chats.length} total chats`);

    const jobsGroup = chats.find(c => c.name === TARGET_GROUP);
    if (jobsGroup) {
      console.log(`✅ Found group: ${TARGET_GROUP} — loading history...`);
      try {
        const messages = await jobsGroup.fetchMessages({ limit: 200 });
        console.log(`Scanning ${messages.length} messages from ${TARGET_GROUP}...`);
        for (const msg of messages) {
          if (msg.body && msg.body.length > 30) {
            addJobMessage(msg, jobsGroup.name);
          }
        }
        console.log(`Done. Found ${jobMessages.length} relevant jobs from group history.`);
      } catch(e) {
        console.log('Error loading group history:', e.message);
      }
    } else {
      console.log(`❌ Group "${TARGET_GROUP}" not found! Available groups:`);
      chats.filter(c => c.isGroup).forEach(c => console.log(' -', c.name));
    }
  } catch(e) {
    console.log('Error finding group:', e.message);
  }

  await scrapeJobSites();
  setInterval(scrapeJobSites, 6 * 60 * 60 * 1000);
});

app.get('/approve/:appId', async (req, res) => {
  const success = await sendApplication(req.params.appId);
  res.send(`<html><body style="font-family:Arial;text-align:center;padding:50px;">
    ${success
      ? '<h1 style="color:green;">✅ Application Sent!</h1><p>CV, Cover Letter & Certificates delivered.</p>'
      : '<h1 style="color:red;">❌ Already Processed</h1>'}
    </body></html>`);
});

app.get('/skip/:appId', (req, res) => {
  if (pendingApplications[req.params.appId]) pendingApplications[req.params.appId].status = 'skipped';
  res.send(`<html><body style="font-family:Arial;text-align:center;padding:50px;">
    <h1 style="color:orange;">⏭️ Job Skipped</h1></body></html>`);
});

app.get('/test-email', async (req, res) => {
  try {
    await transporter.sendMail({
      from: GMAIL_USER,
      to: MY_EMAIL,
      subject: '✅ JobHunter Test Email',
      html: `<h2>JobHunter AI is working!</h2><p>Email notifications are set up correctly.</p>`
    });
    res.json({ success: true, message: 'Test email sent to ' + MY_EMAIL });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/status', (req, res) => {
  res.json({
    ready: isReady,
    watchingGroup: TARGET_GROUP,
    whatsappJobs: jobMessages.length,
    scrapedJobs: scrapedJobs.length,
    pending: Object.keys(pendingApplications).length
  });
});

app.get('/jobs', (req, res) => res.json([...jobMessages, ...scrapedJobs]));
app.get('/pending', (req, res) => res.json(pendingApplications));

app.get('/scrape-now', async (req, res) => {
  res.json({ message: 'Scraping started...' });
  await scrapeJobSites();
});

app.get('/qr', (req, res) => {
  if (isReady) {
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0;">
      <h1 style="color:green;">✅ WhatsApp Connected!</h1>
      <p>👀 Watching group: <strong>${TARGET_GROUP}</strong></p>
      <p>WhatsApp jobs: ${jobMessages.length} | Scraped jobs: ${scrapedJobs.length} | Pending: ${Object.keys(pendingApplications).length}</p>
      <br>
      <a href="/scrape-now" style="background:#25D366;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">🔄 Scrape Now</a>
      &nbsp;
      <a href="/test-email" style="background:#4285f4;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">📧 Test Email</a>
      &nbsp;
      <a href="/status" style="background:#ff9800;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">📊 Status</a>
      </body></html>`);
  } else if (qrCodeData) {
    res.send(`<html><head><meta http-equiv="refresh" content="30"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0;">
      <h1>📱 Scan with WhatsApp</h1>
      <p>Open WhatsApp → Three dots → Linked Devices → Link a Device</p>
      <img src="${qrCodeData}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:12px;"/>
      <p style="color:gray;font-size:14px;">Page auto-refreshes every 30 seconds</p>
      </body></html>`);
  } else {
    res.send(`<html><head><meta http-equiv="refresh" content="3"></head>
      <body style="text-align:center;padding:40px;"><h1>⏳ Loading...</h1></body></html>`);
  }
});

client.initialize();
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
