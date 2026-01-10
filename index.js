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

// חיבור למסד הנתונים
mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("MongoDB error:", err));

const ChatSchema = new mongoose.Schema({
    identifier: String,
    history: Array,
    lastUpdate: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

app.post('/ivr', async (req, res) => {
    const audioUrl = req.body.file_url || req.query.file_url;
    const identifier = req.body.ApiPhone || req.body.ApiUserName || "unknown";

    // שלב א': אם המערכת פונה ללא קובץ אודיו - השרת שולח פקודת הקלטה
    if (!audioUrl) {
        const recordSettings = [
            "type=record",
            "record_name=R1",
            "record_ok=no",
            "record_ask_ok=no",
            "record_finish_messages=no",
            "say_record_menu=no",
            "record_post_action=none",
            "record_beep=yes", // צפצוף בתחילת ההקלטה
            "record_end_time_if_silent=3", // סיום אוטומטי אחרי 3 שניות שקט
            "next=goto_this_ext" // חזרה לשרת מיד בסיום ההקלטה
        ];
        return res.send(recordSettings.join('&'));
    }

    // שלב ב': קיבלנו הקלטה - מתחילים בעיבוד
    try {
        // 1. הורדת הקובץ ושליחה ל-Whisper דרך Groq
        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const transcription = await speechToText(audioRes.data);
        const userText = transcription.data.text;

        // בדיקה אם המשתמש שתק
        if (!userText || userText.trim().length < 2) {
            return res.send("read=t-לא שמעתי את דבריך, אנא נסה שוב.&next=goto_this_ext");
        }

        // 2. ניהול היסטוריית שיחה
        let chat = await Chat.findOne({ identifier });
        if (!chat) chat = new Chat({ identifier, history: [] });

        chat.history.push({ role: "user", parts: [{ text: userText }] });
        if (chat.history.length > 12) chat.history = chat.history.slice(-12);

        // 3. שליחה ל-Gemini לקבלת תשובה
        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: chat.history,
            system_instruction: { parts: [{ text: "ענה בקצרה רבה, ללא סמלים, ללא כותרות וללא הקדמות. ענה כחבר עוזר." }] }
        });

        const reply = geminiRes.data.candidates[0].content.parts[0].text;
        
        // שמירת תשובת המודל להיסטוריה
        chat.history.push({ role: "model", parts: [{ text: reply }] });
        chat.lastUpdate = Date.now();
        await chat.save();

        // 4. החזרת התשובה למשתמש והכנה לשאלה הבאה
        // אנחנו מנקים תווים מיוחדים שעלולים לשבש את הפקודה של ימות המשיח
        const cleanReply = reply.replace(/[&?=#]/g, ' ');
        res.send(`read=t-${cleanReply}&next=goto_this_ext`);

    } catch (e) {
        console.error("General Error:", e.message);
        res.send("read=t-סליחה, חלה שגיאה בעיבוד הנתונים. נסה שוב מאוחר יותר.&next=goto_this_ext");
    }
});

// פונקציית עזר להמרת קול לטקסט
async function speechToText(buffer) {
    const formData = new FormData();
    formData.append('file', buffer, { filename: 'audio.wav' });
    formData.append('model', 'whisper-large-v3');
    return axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
        headers: { 
            ...formData.getHeaders(), 
            'Authorization': `Bearer ${GROQ_API_KEY}` 
        }
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
