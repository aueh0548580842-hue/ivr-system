const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- הגדרות מפתחות ---
const GROQ_API_KEY = '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';
const GEMINI_API_KEY = 'הדבק_כאן_את_המפתח_של_גמיני'; 
const MONGO_URI = "mongodb+srv://aueh0548580842_db_user:5fYAtRADkCGFHmUi@cluster0.emu588n.mongodb.net/myDatabase?retryWrites=true&w=majority";

// חיבור ל-MongoDB
mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("DB Connection Error:", err));

// מודל נתונים
const ChatSchema = new mongoose.Schema({
    phone: String,
    history: Array,
    summary: { type: String, default: "" },
    lastUpdate: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

// --- שלוחה 1: שיחה פעילה ---
app.post('/ivr', async (req, res) => {
    try {
        const audioUrl = req.body.FileUrl || req.query.FileUrl;
        const phone = req.body.ApiPhone || "unknown";
        if (!audioUrl) return res.send("read=t-לא התקבלה הקלטה");

        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const transcription = await speechToText(audioRes.data);
        const userText = transcription.data.text;

        let chat = await Chat.findOne({ phone }).sort({ lastUpdate: -1 });
        if (!chat) chat = new Chat({ phone, history: [] });

        chat.history.push({ role: "user", parts: [{ text: userText }] });

        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: chat.history,
            system_instruction: {
                parts: [{ text: "אתה עוזר חכם. בסוף כל תשובה, הוסף סיכום קצר מאוד של נושא השיחה בסוגריים עגולים (...)." }]
            }
        });

        const fullResponse = geminiRes.data.candidates[0].content.parts[0].text;
        const parts = fullResponse.split('(');
        const cleanResponse = parts[0].replace(/[&*]/g, '').trim();
        const currentSummary = parts[1] ? parts[1].replace(')', '').trim() : "";

        chat.history.push({ role: "model", parts: [{ text: fullResponse }] });
        if (currentSummary) chat.summary = currentSummary;
        chat.lastUpdate = Date.now();
        await chat.save();

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(`read=t-${cleanResponse}&target=1&next=goto_this_ext`);
    } catch (error) {
        res.send("read=t-חלה שגיאה בעיבוד");
    }
});

// --- שלוחה 2: ניהול היסטוריה ודפדוף ---
app.post('/history', async (req, res) => {
    try {
        const phone = req.body.ApiPhone || "unknown";
        const digits = req.body.Digits; 
        
        // שליפת כל השיחות מהחדשה לישנה
        let chats = await Chat.find({ phone }).sort({ lastUpdate: -1 });

        if (chats.length === 0) {
            return res.send("read=t-לא נמצאו שיחות קודמות.&next=goto_main_menu");
        }

        // מחיקת השיחה האחרונה ברשימה
        if (digits === '9') {
            await Chat.findByIdAndDelete(chats[0]._id);
            return res.send("read=t-השיחה נמחקה.&next=goto_this_ext");
        }

        // דפדוף לשיחה הקודמת (אם הקישו 2)
        let chatToShow = (digits === '2' && chats.length > 1) ? chats[1] : chats[0];
        let dateStr = chatToShow.lastUpdate.toLocaleDateString('he-IL');
        
        let msg = `בשיחה מתאריך ${dateStr} דיברנו על ${chatToShow.summary || "נושא כלשהו"}. `;
        msg += "להמשך הקש 1. ";
        if (chats.length > 1 && digits !== '2') msg += "לשיחה קודמת הקש 2. ";
        msg += "למחיקת שיחה זו הקש 9.";

        if (digits === '1') {
            return res.send(`read=t-חוזרים לשיחה.&next=goto_ext-1`);
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(`read=t-${msg}&api_get_digits=1&api_digit_confirm=no`);
    } catch (error) {
        res.send("read=t-שגיאה בגישה לזיכרון");
    }
});

async function speechToText(buffer) {
    const formData = new FormData();
    formData.append('file', buffer, { filename: 'audio.wav', contentType: 'audio/wav' });
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'he');
    return axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
        headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` }
    });
}

app.listen(process.env.PORT || 3000);
