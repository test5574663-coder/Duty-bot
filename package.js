require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes
} = require("discord.js");

const admin = require("firebase-admin");
const serviceAccount = require("./firebase.json");

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ================= ENV =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const ROLE_MANAGER = process.env.ROLE_MANAGER || "";
const ROLE_INTERN = process.env.ROLE_INTERN || "";
const GTA_NAME = (process.env.GTA_ACTIVITY || "").toLowerCase();

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ]
});

// ================= TIME UTILS =================
function nowVN() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );
}

function dateKey() {
  const d = nowVN();
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Ho_Chi_Minh"
  });
}

function diffText(ms) {
  ms = Math.max(0, ms || 0);
  const totalMinutes = Math.floor(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h} giờ ${m} phút`;
}

function isPlaying(member) {
  if (!GTA_NAME) return false;

  const activities = member.presence?.activities || [];

  console.log(
    `[CHECK ACTIVITY] ${member.user.tag}:`,
    activities.map(a => a.name)
  );

  return activities.some(
    a => a.name?.toLowerCase() === GTA_NAME
  );
}

// ================= FIRESTORE UTILS =================
async function getUser(id) {
  const ref = db.collection("onduty").doc(id);
  const snap = await ref.get();

  if (!snap.exists) {
    const data = {
      total: 0,
      days: {}
    };
    await ref.set(data);
    return { ref, data };
  }

  return { ref, data: snap.data() };
}

async function saveUser(ref, data) {
  await ref.set(data);
}

function getOrCreateDay(user, key) {
  if (!user.days) user.days = {};

  if (!user.days[key]) {
    user.days[key] = {
      plate: "",
      sessions: [],
      extra: 0,
      messageId: null,
      channelId: null
    };
  }

  return user.days[key];
}

// ================= EMBED =================
function buildEmbed(member, user, dayKeyValue, status) {
  const day = user.days?.[dayKeyValue];
  if (!day) return null;

  let timeline = "";
  let total = 0;
  const now = Date.now();

  for (const s of day.sessions || []) {
    const end = s.end || now;
    timeline += `${formatTime(s.start)} ➝ ${s.end ? formatTime(s.end) : "Đang trực"}\n`;
    total += end - s.start;
  }

  const extra = Math.max(0, day.extra || 0);
  total += extra;

  const isIntern = !!ROLE_INTERN && member.roles.cache.has(ROLE_INTERN);

  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("BẢNG ONDUTY")
    .setDescription(
`**Tên Nhân Sự:** ${member}

**Biển Số:** ${day.plate || "Chưa có"}

**Thời Gian Onduty:**
${timeline || "Chưa có dữ liệu"}

**Ngày Onduty:** ${dayKeyValue}

**Tổng Thời Gian Onduty:** ${diffText(total)}${isIntern ? `

**Thực Tập:** ${diffText(Math.max(0, user.total || 0))} / 60h` : ""}

**Trạng Thái Hoạt Động:** ${status || "Không có"}`
    )
    .setTimestamp();
}

// ================= SEND / UPDATE EMBED =================
async function sendOrUpdate(channel, member, user, dayKeyValue, status, ref) {
  try {
    const day = user.days?.[dayKeyValue];
    if (!day) return;

    const embed = buildEmbed(member, user, dayKeyValue, status);
    if (!embed) return;

    // Update embed cũ nếu còn
    if (day.messageId && day.channelId) {
      try {
        const ch = await client.channels.fetch(day.channelId).catch(() => null);
        const msg = ch ? await ch.messages.fetch(day.messageId).catch(() => null) : null;

        if (msg) {
          await msg.edit({
            content: `<@${member.id}>`,
            embeds: [embed]
          });
          return;
        }
      } catch (err) {
        console.error("⚠️ Không update được embed cũ:", err);
      }
    }

    // Gửi embed mới
    const msg = await channel.send({
      content: `<@${member.id}>`,
      embeds: [embed]
    });

    day.messageId = msg.id;
    day.channelId = channel.id;

    await saveUser(ref, user);
  } catch (err) {
    console.error("❌ sendOrUpdate lỗi:", err);
  }
}

// ================= REGISTER COMMANDS =================
const commands = [
  new SlashCommandBuilder()
    .setName("onduty")
    .setDescription("Bắt đầu ca trực")
    .addStringOption(opt =>
      opt.setName("bienso")
        .setDescription("Biển số mới")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("offduty")
    .setDescription("Kết thúc ca trực"),

  new SlashCommandBuilder()
    .setName("thaybienso")
    .setDescription("Thay đổi biển số")
    .addStringOption(opt =>
      opt.setName("bienso")
        .setDescription("Biển số mới")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("penalty")
    .setDescription("Cộng thời gian cho nhân sự")
    .addUserOption(opt =>
      opt.setName("user")
        .setDescription("Chọn nhân sự")
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName("minute")
        .setDescription("Số phút cộng")
        .setRequired(true)
        .setMinValue(1)
    )
    .addStringOption(opt =>
      opt.setName("options")
        .setDescription("Chọn loại thời gian")
        .setRequired(true)
        .addChoices(
          { name: "Thời Gian Onduty", value: "onduty" },
          { name: "Thời Gian Thực Tập", value: "intern" }
        )
    ),

  new SlashCommandBuilder()
    .setName("adjust")
    .setDescription("Trừ thời gian của nhân sự")
    .addUserOption(opt =>
      opt.setName("user")
        .setDescription("Chọn nhân sự")
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName("minute")
        .setDescription("Số phút trừ")
        .setRequired(true)
        .setMinValue(1)
    )
    .addStringOption(opt =>
      opt.setName("options")
        .setDescription("Chọn loại thời gian")
        .setRequired(true)
        .addChoices(
          { name: "Thời Gian Onduty", value: "onduty" },
          { name: "Thời Gian Thực Tập", value: "intern" }
        )
    ),

  new SlashCommandBuilder()
    .setName("forceoff")
    .setDescription("Cưỡng chế kết thúc ca trực")
    .addUserOption(opt =>
      opt.setName("user")
        .setDescription("Chọn nhân sự cần force off")
        .setRequired(true)
    )
].map(c => c.toJSON());

// ================= READY =================
client.once("ready", async () => {
  console.log(`🤖 ${client.user.tag}`);

  try {
    console.log("🔄 Đăng ký lại command...");
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log("✅ Done");
  } catch (err) {
    console.error("❌ Lỗi register command:", err);
  }
});

// ================= COMMAND HANDLER =================
client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand()) return;

  try {
    const hiddenCommands = new Set(["onduty", "offduty", "thaybienso", "forceoff"]);
    await i.deferReply({ ephemeral: hiddenCommands.has(i.commandName) });

    const member = await i.guild.members.fetch(i.user.id);
    const { ref, data: user } = await getUser(member.id);
    const today = dateKey();
    const day = getOrCreateDay(user, today);

    // ================= ONDUTY =================
    if (i.commandName === "onduty") {
      if (GTA_NAME && !isPlaying(member)) {
        return i.editReply("❌ Bạn phải vào game trước khi ON DUTY");
      }

      if (day.sessions.some(s => !s.end)) {
        return i.editReply("❌ Bạn đang ON DUTY rồi");
      }

      day.plate = i.options.getString("bienso");
      day.sessions.push({ start: Date.now(), end: null });

      await saveUser(ref, user);
      await i.editReply("✅ ON DUTY");

      void sendOrUpdate(i.channel, member, user, today, "Đang trực", ref)
        .catch(console.error);

      return;
    }

    // ================= OFFDUTY =================
    if (i.commandName === "offduty") {
      const last = day.sessions.find(s => !s.end);
      if (!last) {
        return i.editReply("❌ Bạn chưa ON DUTY");
      }

      last.end = Date.now();
      user.total += last.end - last.start;

      await saveUser(ref, user);
      await i.editReply("🔴 OFF DUTY");

      void sendOrUpdate(i.channel, member, user, today, "Tự OFF", ref)
        .catch(console.error);

      return;
    }

    // ================= THAY BIỂN =================
    if (i.commandName === "thaybienso") {
      const last = day.sessions.find(s => !s.end);
      if (!last) {
        return i.editReply("❌ Bạn chưa ON DUTY");
      }

      day.plate = i.options.getString("bienso");

      await saveUser(ref, user);
      await i.editReply("✅ Đã đổi biển số");

      void sendOrUpdate(i.channel, member, user, today, "Đổi biển số", ref)
        .catch(console.error);

      return;
    }

    // ================= PENALTY / ADJUST =================
    if (i.commandName === "penalty" || i.commandName === "adjust") {
      if (!member.roles.cache.has(ROLE_MANAGER)) {
        return i.editReply("❌ Bạn không có quyền dùng lệnh này");
      }

      const targetUser = i.options.getUser("user");
      const minute = i.options.getInteger("minute");
      const option = i.options.getString("options");

      const { ref: r, data: target } = await getUser(targetUser.id);
      const targetMember = await i.guild.members.fetch(targetUser.id);
      const targetDay = getOrCreateDay(target, today);

      const ms = minute * 60000;
      const add = i.commandName === "penalty";

      let status = "";

      if (option === "onduty") {
        targetDay.extra = Math.max(0, (targetDay.extra || 0) + (add ? ms : -ms));
        status = `${add ? "+" : "-"} ${minute} phút Onduty`;
      }

      if (option === "intern") {
        target.total = Math.max(0, (target.total || 0) + (add ? ms : -ms));
        status = `${add ? "+" : "-"} ${minute} phút Thực tập`;
      }

      await saveUser(r, target);
      await i.editReply(`✅ ${status}`);

      void sendOrUpdate(i.channel, targetMember, target, today, status, r)
        .catch(console.error);

      return;
    }

    // ================= FORCE OFF =================
    if (i.commandName === "forceoff") {
      if (!member.roles.cache.has(ROLE_MANAGER)) {
        return i.editReply("❌ Bạn không có quyền dùng lệnh này");
      }

      const targetUser = i.options.getUser("user");
      const { ref: r, data: target } = await getUser(targetUser.id);

      const d = target.days?.[today];
      if (!d) {
        return i.editReply("❌ Người này chưa ON DUTY");
      }

      const last = d.sessions.find(s => !s.end);
      if (!last) {
        return i.editReply("❌ Người này đã OFF DUTY");
      }

      last.end = Date.now();
      target.total += last.end - last.start;

      await saveUser(r, target);
      await i.editReply("🚫 Force OFF thành công");

      const targetMember = await i.guild.members.fetch(targetUser.id);
      void sendOrUpdate(i.channel, targetMember, target, today, "Force OFF", r)
        .catch(console.error);

      return;
    }
  } catch (err) {
    console.error("❌ interactionCreate lỗi:", err);

    try {
      if (i.deferred || i.replied) {
        await i.editReply("❌ Có lỗi xảy ra khi xử lý lệnh.");
      } else {
        await i.reply({ content: "❌ Có lỗi xảy ra khi xử lý lệnh.", ephemeral: true });
      }
    } catch {}
  }
});

// ================= AUTO OFF KHI THOÁT GAME =================
client.on("presenceUpdate", async (oldP, newP) => {
  if (!GTA_NAME) return;

  try {
    const member = newP?.member;
    if (!member) return;

    const wasPlaying = oldP?.activities?.some(a =>
      a.name?.toLowerCase().includes(GTA_NAME)
    ) || false;

    const isNowPlaying = newP?.activities?.some(a =>
      a.name?.toLowerCase().includes(GTA_NAME)
    ) || false;

    // từ chơi -> không chơi
    if (wasPlaying && !isNowPlaying) {
      const { ref, data: user } = await getUser(member.id);
      const today = dateKey();
      const day = user.days?.[today];
      if (!day) return;

      const last = day.sessions.find(s => !s.end);
      if (!last) return;

      last.end = Date.now();
      user.total += last.end - last.start;

      await saveUser(ref, user);

      if (day.channelId) {
        const ch = await client.channels.fetch(day.channelId).catch(() => null);
        if (!ch) return;

        void sendOrUpdate(ch, member, user, today, "Tự off (Thoát game)", ref)
          .catch(console.error);
      }
    }
  } catch (err) {
    console.error("❌ presenceUpdate lỗi:", err);
  }
});

// ================= AUTO OFF KHI QUA NGÀY MỚI =================
let lastResetDate = "";

setInterval(async () => {
  try {
    const now = nowVN();
    const todayVN = now.toLocaleDateString("vi-VN");

    if (now.getHours() !== 0 || now.getMinutes() !== 0) return;
    if (lastResetDate === todayVN) return;

    lastResetDate = todayVN;
    console.log("🌙 Reset ngày mới...");

    const docs = await db.collection("onduty").listDocuments();

    for (const doc of docs) {
      try {
        const snap = await doc.get();
        const user = snap.data();
        if (!user) continue;

        const keys = Object.keys(user.days || {});
        const lastKey = keys[keys.length - 1];
        if (!lastKey) continue;

        const day = user.days[lastKey];
        if (!day) continue;

        const last = day.sessions.find(s => !s.end);
        if (!last) continue;

        last.end = Date.now();
        user.total += last.end - last.start;

        await doc.set(user);

        if (day.channelId) {
          const guild = client.guilds.cache.first();
          if (!guild) continue;

          const member = await guild.members.fetch(doc.id).catch(() => null);
          if (!member) continue;

          const ch = await client.channels.fetch(day.channelId).catch(() => null);
          if (!ch) continue;

          void sendOrUpdate(ch, member, user, lastKey, "Tự off (Qua ngày mới)", doc)
            .catch(console.error);
        }
      } catch (err) {
        console.error(`❌ Lỗi reset user ${doc.id}:`, err);
      }
    }
  } catch (err) {
    console.error("❌ Lỗi reset ngày mới:", err);
  }
}, 60000);

// ================= ANTI CRASH =================
process.on("unhandledRejection", err => {
  console.error("❌ Unhandled Rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("uncaughtExceptionMonitor", err => {
  console.error("❌ Uncaught Exception Monitor:", err);
});

// ================= LOGIN =================
client.login(TOKEN).catch(err => {
  console.error("❌ Login Discord lỗi:", err);
});
