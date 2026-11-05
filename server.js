
import "dotenv/config";
import Groq from "groq-sdk";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const model = "openai/gpt-oss-20b";

const MAX_MESSAGE_LENGTH = 4000; // characters per message
const MAX_HISTORY = 10;          // earlier messages sent back to the AI

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

// Keep only valid, trimmed history items from the browser.
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      (item) =>
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.trim()
    )
    .slice(-MAX_HISTORY)
    .map((item) => ({
      role: item.role,
      content: item.content.slice(0, MAX_MESSAGE_LENGTH)
    }));
}

async function askGroq(message, history) {
  const completion = await groq.chat.completions.create({
    model: model,
    messages: [
      { role: "system", content: KRANTI_INSTRUCTIONS },
      ...history,
      { role: "user", content: message }
    ]
  });

  return (
    completion.choices[0].message.content ||
    "I couldn't generate a response."
  );
}

app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: "Please provide a valid message."
      });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        error: "That message is too long. Please shorten it."
      });
    }

    const history = cleanHistory(req.body.history);
    const reply = await askGroq(message.trim(), history);

    res.json({ reply });
  } catch (error) {
    console.error("Groq API error:", error);

    res.status(500).json({
      error: "Something went wrong while generating a response."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI KRANTI running on port ${PORT}`);
});