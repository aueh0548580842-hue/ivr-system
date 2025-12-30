const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- הגדרות מפתחות ---
const GROQ_API_KEY = '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';
const GEMINI_API_KEY = 'כאן_להדביק_את_המפתח_של_גמיני'; 

// מחרוזת החיבור שלך מהצילום (מעודכנת עם המשתמש והסיסמה שנוצרו לך)
const MONGO_URI = "mongodb+srv://aueh0548580842_db_user:5fYAtRADkCGFHmUi@cluster0.emu588n.mongodb.net/myDatabase?retryWrites=true&w=majority";

// חיבור למסד הנתונים
mongoose.connect(MONGO_URI)
    .then(() => console.log("מחובר ל-MongoDB בהצלחה"))
    .catch(err => console.error("שגיאת חיבור:", err));

// הגדרת מבנה שמירת השיחות
const ChatSchema = new mongoose.Schema({
    phone: String,
    history: Array,
    lastUpdate: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

// --- שלוחה 1: ניהול השיחה והזיכרון ---
app.post('/ivr', async (req, res) => {
    try {
        const audioUrl = req.body.FileUrl || req.query.FileUrl;
        const phone = req.body.ApiPhone || "unknown";

        if (!audioUrl) return res.send("read=t-לא התקבלה הקלטה");

        // 1. תמלול הקול (Groq)
        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const transcription = await speechToText(audioRes.data);
        const userText = transcription.data.text;

        // 2. שליפת היסטוריה מהזיכרון הקבוע
        let chat = await Chat.findOne({ phone }).sort({ lastUpdate: -1 });
        if (!chat) chat = new Chat({ phone, history: [] });

        // 3. הוספת דברי המשתמש
        chat.history.push({ role: "user", parts: [{ text: userText }] });

        // 4. שליחה לג'מיני עם ההקשר המלא
        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: chat.history
        });

        const aiResponse = geminiRes.data.candidates[0].content.parts[0].text;
        
        // 5. שמירת התשובה בזיכרון
        chat.history.push({ role: "model", parts: [{ text: aiResponse }] });
        chat.lastUpdate = Date.now();
        await chat.save();

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(`read=t-${aiResponse.replace(/[&*]/g, '')}&target=1&next=goto_this_ext`);

    } catch (error) {
        res.send("read=t-שגיאה בעיבוד השיחה");
    }
});

// --- שלוחה 2: ניהול היסטוריה (מחיקה) ---
app.post('/history', async (req, res) => {
    try {
        const phone = req.body.ApiPhone || "unknown";
        await Chat.deleteMany({ phone });
        res.send("read=t-כל היסטוריית השיחות שלך נמחקה.");
    } catch (error) {
        res.send("read=t-שגיאה במחיקה");
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

app.get('/', (req, res) => res.send("Server Online"));
app.listen(process.env.PORT || 3000);
