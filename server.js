import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import express from "express";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static("public"));
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const model = "gemini-flash-latest";


async function askGemini(message) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Gemini attempt ${attempt}...`);

      const response = await ai.models.generateContent({
        model: model,
        contents: message,
        config: {
          systemInstruction:
            "You are a friendly chatbot. Give short, clear answers in 2-4 sentences unless the user asks for details."
        }
      });

      return response.text || "I couldn't generate a response.";

    } catch (error) {
      console.error("Gemini error:", error);

      const status = error.status || error.code;

      if (
        (status === 503 || status === 429) &&
        attempt < maxAttempts
      ) {
        const delay = attempt * 2000;

        console.log(`Retrying in ${delay / 1000} seconds...`);

        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}

// API endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Please provide a valid message."
      });
    }

    const reply = await askGemini(message);

    res.json({ reply });

  } catch (error) {
    console.error("Chat API error:", error);
    res.status(500).json({
      error: "Something went wrong while generating a response."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Chatbot API running at http://localhost:${PORT}`);
});