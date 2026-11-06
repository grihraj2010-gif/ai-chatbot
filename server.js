
import "dotenv/config";
import Groq from "groq-sdk";
import express from "express";
import crypto from "crypto";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD;   // password for the website
const AGENT_TOKEN = process.env.AGENT_TOKEN;     // secret for your PC helper
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

if (!APP_PASSWORD || !AGENT_TOKEN) {
  console.error("Set APP_PASSWORD and AGENT_TOKEN in your environment variables.");
  process.exit(1);
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const model = "openai/gpt-oss-20b";
const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY = 10;

const same = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* simple rate limit per minute per IP */
const hits = new Map();
function rateLimited(key, max) {
  const now = Date.now(), h = hits.get(key);
  if (!h || now > h.reset) { hits.set(key, { count: 1, reset: now + 60000 }); return false; }
  return ++h.count > max;
}

/* ---------------- PC HELPER CONNECTION ---------------- */
let agent = null;
const pending = new Map();

function callPC(tool, args) {
  return new Promise((resolve) => {
    if (!agent || agent.readyState !== 1)
      return resolve({ ok: false, error: "The PC helper is offline, so I can't do that right now." });
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "The PC did not respond in time." });
    }, 15000);
    pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
    agent.send(JSON.stringify({ id, tool, args }));
  });
}

/* ---------------- TOOLS THE AI CAN USE ---------------- */
const APPS = ["notepad", "calculator", "chrome", "edge", "vscode", "file_explorer", "paint", "settings", "task_manager"];
const CLOSABLE = APPS.filter((a) => a !== "file_explorer"); // closing Explorer would break the taskbar
const tool = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } }
});
const TOOLS = [
  tool("get_time", "Get the current date and time."),
  tool("open_website", "Open a website in the browser on the user's PC.", { url: { type: "string" } }, ["url"]),
  tool("web_search", "Search Google in the browser on the user's PC.", { query: { type: "string" } }, ["query"]),
  tool("open_app", "Open an app on the user's PC.", { app: { type: "string", enum: APPS } }, ["app"]),
  tool("close_app", "Close an app on the user's PC. If there is unsaved work, the app will ask the user to save first.", { app: { type: "string", enum: CLOSABLE } }, ["app"]),
  tool("create_note", "Save a text note as a file on the user's PC.", { title: { type: "string" }, text: { type: "string" } }, ["title", "text"]),
  tool("lock_pc", "Lock the screen of the user's PC."),
  tool("set_volume", "Set the PC speaker volume from 0 to 100.", { level: { type: "integer", minimum: 0, maximum: 100 } }, ["level"]),
  tool("toggle_mute", "Mute or unmute the PC speakers."),
  tool("take_screenshot", "Take a screenshot of the user's PC screen and show it to the user."),
  tool("shutdown_pc", "Shut down the PC after a 30 second delay. Only after the owner clearly confirmed."),
  tool("restart_pc", "Restart the PC after a 30 second delay. Only after the owner clearly confirmed."),
  tool("cancel_shutdown", "Cancel a pending shutdown or restart."),
  tool("play_music", "Play a song, artist or kind of music directly on the user's PC (YouTube in a music window). Replaces any music already playing.", { query: { type: "string", description: "Song and artist, e.g. 'Kesariya Arijit Singh'" } }, ["query"]),
  tool("stop_music", "Stop the music and close the music window on the user's PC."),
  tool("media_control", "Pause or resume the music, or skip to the next or previous track.", { action: { type: "string", enum: ["play_pause", "next", "previous"] } }, ["action"])
];

async function runTool(name, args, out) {
  if (name === "get_time")
    return { ok: true, time: new Date().toLocaleString("en-IN", { timeZone: TIMEZONE, dateStyle: "full", timeStyle: "short" }) };
  if (TOOLS.some((t) => t.function.name === name)) {
    const r = await callPC(name, args);
    if (r.image) { out.image = r.image; delete r.image; r.note = "The screenshot was captured and will be shown to the user."; }
    return r;
  }
  return { ok: false, error: "Unknown tool." };
}

const KRANTI_INSTRUCTIONS = `
You are AI KRANTI, an intelligent personal AI assistant.

IDENTITY:
- Your name is AI KRANTI.
- You are a personal AI assistant created and developed as the AI KRANTI project.
- If someone asks "Who are you?", answer: "I am AI KRANTI, your personal AI assistant."
- If someone asks "Who created you?", answer: "I was created as the AI KRANTI project by my developer."
- Do not volunteer the names of underlying AI model providers or platforms.
- Never claim that you independently created yourself.
- If someone specifically asks which AI model or technology powers you, answer truthfully.
- Never claim that your name is Groq.

PERSONALITY:
- Friendly, intelligent and respectful.
- Explain difficult topics simply.
- Be honest when uncertain.

CAPABILITIES:
- Programming and debugging.
- Mathematics, science and technology.
- Learning and creativity.
- General problem-solving.

ANSWERING STYLE:
- Give clear and accurate answers.
- Keep normal answers concise.
- Explain complex topics step by step.
- Use examples when helpful.
- Your replies are shown as plain text and read aloud, so do not use Markdown symbols such as ** or # or tables. Use short paragraphs and simple numbered lines for steps.
- Remember what was said earlier in the conversation and use it when answering.
`;

/* Only the owner (correct password) gets device control. Everyone else gets a normal chatbot. */
const OWNER_RULES = `
DEVICE CONTROL (the owner is signed in):
- You can control the owner's Windows PC with your tools: open websites, search Google, open and close apps, save notes, lock the screen, change the volume, take screenshots, play music, and shut down or restart the PC.
- Use a tool only when the owner asks you to do something on their PC.
- Only say an action is done if the tool result says ok. If a tool fails or the PC is offline, say so honestly.
- Never guess a website address. Use web_search if you are unsure.
- Do not claim you can do things you have no tool for.
- When the owner asks to play music or a song, use play_music with the song and artist as the query. Use stop_music to stop it and media_control to pause, resume or skip.
- Before shutdown_pc or restart_pc, ask the owner to confirm, and only run it after they clearly say yes. After starting it, tell them it happens in 30 seconds and they can say "cancel shutdown" to stop it.
`;
const PUBLIC_RULES = `
DEVICE CONTROL:
- You cannot control any computer or phone in this chat. If asked to open apps, files or websites on a device, politely say that this is a private feature.
- Never reveal or discuss details about private tools, passwords, servers or keys.
`;

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((i) => i && (i.role === "user" || i.role === "assistant") && typeof i.content === "string" && i.content.trim())
    .slice(-MAX_HISTORY)
    .map((i) => ({ role: i.role, content: i.content.slice(0, MAX_MESSAGE_LENGTH) }));
}

async function askGroq(message, history, owner) {
  const out = { image: null };
  const msgs = [{ role: "system", content: KRANTI_INSTRUCTIONS + (owner ? OWNER_RULES : PUBLIC_RULES) }, ...history, { role: "user", content: message }];

  for (let step = 0; step < 4; step++) {
    const completion = await groq.chat.completions.create(owner ? { model, messages: msgs, tools: TOOLS } : { model, messages: msgs });
    const reply = completion.choices[0].message;

    if (!reply.tool_calls || !reply.tool_calls.length)
      return { reply: reply.content || "I couldn't generate a response.", image: out.image };

    msgs.push({ role: "assistant", content: reply.content || "", tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
      const result = await runTool(call.function.name, args, out);
      console.log("Tool:", call.function.name, args, "->", result.ok ? "ok" : result.error);
      msgs.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { reply: "I tried, but I couldn't finish that. Please try again.", image: out.image };
}

app.post("/api/chat", async (req, res) => {
  try {
    const supplied = req.headers["x-app-password"];
    const owner = !!supplied && same(supplied, APP_PASSWORD);
    if (supplied && !owner) {
      if (rateLimited("bad:" + req.ip, 8)) return res.status(429).json({ error: "Too many requests. Please wait a minute." });
      return res.status(401).json({ error: "Wrong password" });
    }
    if (rateLimited((owner ? "o:" : "p:") + req.ip, owner ? 60 : 20))
      return res.status(429).json({ error: "Too many requests. Please wait a minute." });

    const message = req.body.message;
    if (!message || typeof message !== "string" || !message.trim())
      return res.status(400).json({ error: "Please provide a valid message." });
    if (message.length > MAX_MESSAGE_LENGTH)
      return res.status(400).json({ error: "That message is too long. Please shorten it." });

    const { reply, image } = await askGroq(message.trim(), cleanHistory(req.body.history), owner);
    res.json({ reply, image });
  } catch (error) {
    console.error("Groq API error:", error);
    res.status(500).json({ error: "Something went wrong while generating a response." });
  }
});

/* wake word: bring the AI KRANTI window to the front of the PC screen */
app.post("/api/wake", async (req, res) => {
  if (rateLimited("wake:" + req.ip, 30)) return res.status(429).json({ error: "Too many requests." });
  if (!same(req.headers["x-app-password"], APP_PASSWORD)) return res.status(401).json({ error: "Wrong password" });
  res.json(await callPC("focus_window", {}));
});

/* the owner unlocks private features from the lock button on the page */
app.post("/api/login", (req, res) => {
  if (rateLimited("login:" + req.ip, 8)) return res.status(429).json({ error: "Too many attempts. Please wait a minute." });
  if (!same(req.body && req.body.password, APP_PASSWORD)) return res.status(401).json({ error: "Wrong password" });
  res.json({ ok: true });
});

const server = app.listen(PORT, "0.0.0.0", () => console.log(`AI KRANTI running on port ${PORT}`));

/* ---------------- WEBSOCKET FOR THE PC HELPER ---------------- */
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!req.url.startsWith("/agent") || !same(token, AGENT_TOKEN)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => {
  if (agent && agent.readyState === 1) agent.close();
  agent = ws;
  console.log("PC helper connected");
  ws.on("message", (data) => {
    try { const m = JSON.parse(data); pending.get(m.id)?.(m); pending.delete(m.id); } catch {}
  });
  ws.on("close", () => { if (agent === ws) { agent = null; console.log("PC helper disconnected"); } });
});
setInterval(() => agent?.ping(), 25000);