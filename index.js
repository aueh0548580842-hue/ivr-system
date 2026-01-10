const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// מפתחות נלקחים ממשתני הסביבה ב-Render לאבטחה מירבית
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("MongoDB connection error:", err));

const ChatSchema = new mongoose.Schema({
    identifier: String,
    history: Array,
    summary: { type: String, default: "" },
    lastUpdate: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

app.post('/ivr', async (req, res) => {
    try {
        // התאמה לפרמטר מה-ext.ini של שלוחה 10
        const audioUrl = req.body.file_url || req.query.file_url;
        const identifier = req.body.ApiUserName || req.body.ApiPhone || "unknown";

        if (!audioUrl) return res.send("read=t-לא התקבלה הקלטה. אנא נסה שוב.");

        // הורדת הקובץ ושליחה ל-STT
        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const transcription = await speechToText(audioRes.data);
        const userText = transcription.data.text;

        // בדיקה אם המשתמש שתק
        if (!userText || userText.trim().length < 2) {
            return res.send("read=t-לא שמעתי את דבריך, אנא דבר חזק יותר.");
        }

        let chat = await Chat.findOne({ identifier }).sort({ lastUpdate: -1 });
        if (!chat) chat = new Chat({ identifier, history: [] });

        // הוספת השאלה להיסטוריה
        chat.history.push({ role: "user", parts: [{ text: userText }] });
        if (chat.history.length > 12) chat.history = chat.history.slice(-12);

        // פנייה לג'מיני
        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: chat.history,
            system_instruction: { parts: [{ text: "ענה בקצרה. בסוף התשובה הוסף את המילה 'סיכום:' ואחריה תיאור קצר מאוד של נושא השאלה." }] }
        });

        const fullResponse = geminiRes.data.candidates[0].content.parts[0].text;
        
        // פיצול התשובה מהסיכום
        const parts = fullResponse.split('סיכום:');
        const cleanResponse = parts[0].trim();
        if (parts[1]) chat.summary = parts[1].trim();

        chat.history.push({ role: "model", parts: [{ text: fullResponse }] });
        chat.lastUpdate = Date.now();
        await chat.save();

        // החזרת תשובה למערכת וחזרה לשלוחה 1
        res.send(`read=t-${cleanResponse}&target=1&next=goto_ext-1`);

    } catch (e) {
        console.error("Error Detail:", e.response ? e.response.data : e.message);
        res.send("read=t-סליחה, חלה שגיאה בעיבוד הנתונים.");
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
