const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// מפתחות אבטחה - יש להגדיר ב-Environment של Render
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI);

const ChatSchema = new mongoose.Schema({
    identifier: String,
    history: Array,
    lastUpdate: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

app.post('/ivr', async (req, res) => {
    const audioUrl = req.body.file_url || req.query.file_url;
    const identifier = req.body.ApiPhone || req.body.ApiUserName || "unknown";

    // שלב א': אם אין הקלטה בבקשה - השרת פוקד על המערכת להקליט מיד
    if (!audioUrl) {
        return res.send(`
            type=record
            record_name=R1
            record_ok=no
            record_ask_ok=no
            record_finish_messages=no
            say_record_menu=no
            record_post_action=none
            record_end_time_if_silent=3
            next=goto_this_ext
        `.trim().replace(/\n/g, '&'));
    }

    // שלב ב': יש הקלטה - השרת מעבד אותה
    try {
        // הורדת הקובץ ושליחה ל-Whisper (Groq)
        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const transcription = await speechToText(audioRes.data);
        const userText = transcription.data.text;

        if (!userText || userText.trim().length < 2) {
            return res.send("read=t-לא שמעתי, נסה שוב.&next=goto_this_ext");
        }

        // ניהול היסטוריית שיחה ב-MongoDB
        let chat = await Chat.findOne({ identifier });
        if (!chat) chat = new Chat({ identifier, history: [] });

        chat.history.push({ role: "user", parts: [{ text: userText }] });
        if (chat.history.length > 10) chat.history = chat.history.slice(-10);

        // שליחה ל-Gemini
        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: chat.history,
            system_instruction: { parts: [{ text: "ענה בקצרה רבה. ללא כותרות וללא סיכומים." }] }
        });

        const reply = geminiRes.data.candidates[0].content.parts[0].text;
        chat.history.push({ role: "model", parts: [{ text: reply }] });
        chat.lastUpdate = Date.now();
        await chat.save();

        // החזרת התשובה והכנה להקלטה הבאה
        res.send(`read=t-${reply.replace(/[&?]/g, ' ')}&next=goto_this_ext`);

    } catch (e) {
        console.error("Error:", e.message);
        res.send("read=t-חלה שגיאה בעיבוד הקול, נסה שוב.&next=goto_this_ext");
    }
});

async function speechToText(buffer) {
    const formData = new FormData();
    formData.append('file', buffer, { filename: 'audio.wav' });
    formData.append('model', 'whisper-large-v3');
    return axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
        headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` }
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
