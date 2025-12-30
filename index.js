const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- הגדרות מפתחות ---
// וודא שהדבקת כאן את המפתח של ג'מיני שלך
const GROQ_API_KEY = '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';
const GEMINI_API_KEY = 'הדבק_כאן_את_המפתח_של_גמיני'; 
const MONGO_URI = "mongodb+srv://aueh0548580842_db_user:5fYAtRADkCGFHmUi@cluster0.emu588n.mongodb.net/myDatabase?retryWrites=true&w=majority";

// חיבור למסד הנתונים MongoDB
mongoose.connect(MONGO_URI)
    .then(() => console.log("מחובר ל-MongoDB בהצלחה"))
    .catch(err => console.error("שגיאת חיבור למסד הנתונים:", err));

// הגדרת מבנה נתונים לשמירת השיחה
const ChatSchema = new mongoose.Schema({
    phone: String,
    history: Array,
    summary: { type: String, default: "" },
    lastUpdate: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

// --- שלוחה 1: ניהול השיחה עם ג'מיני ---
app.post('/ivr', async (req, res) => {
    try {
        const audioUrl = req.body.FileUrl || req.query.FileUrl;
        const phone = req.body.ApiPhone || "unknown";

        if (!audioUrl) return res.send("read=t-לא התקבלה הקלטה");

        // 1. הורדה ותמלול הקול (Groq)
        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const transcription = await speechToText(audioRes.data);
        const userText = transcription.data.text;

        // 2. שליפת היסטוריה מהזיכרון
        let chat = await Chat.findOne({ phone }).sort({ lastUpdate: -1 });
        if (!chat) chat = new Chat({ phone, history: [] });

        // 3. הוספת דברי המשתמש
        chat.history.push({ role: "user", parts: [{ text: userText }] });

        // 4. בקשה מג'מיני עם הנחיית סיכום
        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: chat.history,
            system_instruction: {
                parts: [{ text: "אתה עוזר חכם בטלפון. בסוף כל תשובה, הוסף סיכום קצר מאוד של השיחה בסוגריים עגולים (...). הסיכום נועד לזיכרון הפנימי בלבד." }]
            }
        });

        const fullResponse = geminiRes.data.candidates[0].content.parts[0].text;
        
        // הפרדת התשובה מהסיכום
        const parts = fullResponse.split('(');
        const cleanResponse = parts[0].replace(/[&*]/g, '').trim();
        const currentSummary = parts[1] ? parts[1].replace(')', '').trim() : "";

        // 5. שמירה בזיכרון הקבוע
        chat.history.push({ role: "model", parts: [{ text: fullResponse }] });
        if (currentSummary) chat.summary = currentSummary;
        chat.lastUpdate = Date.now();
        await chat.save();

        // 6. החזרת תשובה למתקשר (עם אפשרות להקיש 1 להמשך)
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(`read=t-${cleanResponse}&target=1&next=goto_this_ext`);

    } catch (error) {
        console.error(error);
        res.send("read=t-חלה שגיאה בעיבוד השיחה");
    }
});

// --- שלוחה 2: תפריט היסטוריה (הקראה, המשך ומחיקה) ---
app.post('/history', async (req, res) => {
    try {
        const phone = req.body.ApiPhone || "unknown";
        const digits = req.body.Digits; // קליטת הקשה מהמתקשר

        let chat = await Chat.findOne({ phone }).sort({ lastUpdate: -1 });

        if (!chat) {
            return res.send("read=t-לא נמצאו שיחות קודמות בזיכרון.&next=goto_main_menu");
        }

        // אם המשתמש הקיש 9 - מחיקת ההיסטוריה
        if (digits === '9') {
            await Chat.deleteMany({ phone });
            return res.send("read=t-כל היסטוריית השיחות שלך נמחקה.&next=goto_main_menu");
        }

        // אם המשתמש הקיש 1 - המשך לשיחה הפעילה (שלוחה 1)
        if (digits === '1') {
            return res.send("read=t-מיד נמשיך בשיחה.&next=goto_ext-1");
        }

        // הודעת תפריט ההיסטוריה (מושמעת כשנכנסים לשלוחה 2)
        const summaryText = chat.summary ? `בשיחה האחרונה דיברנו על ${chat.summary}.` : "נמצאה שיחה קודמת.";
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(`read=t-${summaryText} להמשך השיחה הקש 1. למחיקה הקש 9.&api_get_digits=1&api_digit_confirm=no`);

    } catch (error) {
        res.send("read=t-שגיאה בגישה לנתוני השיחות.");
    }
});

// פונקציית עזר לתמלול
async function speechToText(buffer) {
    const formData = new FormData();
    formData.append('file', buffer, { filename: 'audio.wav', contentType: 'audio/wav' });
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'he');
    return axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
        headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` }
    });
}

app.get('/', (req, res) => res.send("Server Alive"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
