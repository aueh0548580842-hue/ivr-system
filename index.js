const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const GROQ_API_KEY = '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';
const GEMINI_API_KEY = 'מפתח_גמיני_שלך'; 
const ELEVENLABS_API_KEY = 'sk_7ecb6eb9a7dd72f00bb2c3443b7ae07440da6c84784a18ab';
const AGENT_ID = 'agent_2901kdr1h9nrf7arhjycvdz4bfbt';
const MONGO_URI = "mongodb+srv://aueh0548580842_db_user:5fYAtRADkCGFHmUi@cluster0.emu588n.mongodb.net/myDatabase?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI);

const ChatSchema = new mongoose.Schema({
    identifier: String,
    history: Array,
    summary: { type: String, default: "" },
    lastUpdate: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

app.post('/ivr', async (req, res) => {
    try {
        const audioUrl = req.body.FileUrl || req.query.FileUrl;
        const identifier = req.body.ApiUserName || req.body.ApiPhone || "unknown";
        if (!audioUrl) return res.send("read=t-חסרה הקלטה");

        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const transcription = await speechToText(audioRes.data);
        const userText = transcription.data.text;

        let chat = await Chat.findOne({ identifier }).sort({ lastUpdate: -1 });
        if (!chat) chat = new Chat({ identifier, history: [] });

        chat.history.push({ role: "user", parts: [{ text: userText }] });

        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: chat.history,
            system_instruction: { parts: [{ text: "ענה בקצרה ובמקצועיות. הוסף בסוף (סיכום: נושא השיחה)." }] }
        });

        const fullResponse = geminiRes.data.candidates[0].content.parts[0].text;
        const parts = fullResponse.split('(סיכום:');
        const cleanResponse = parts[0].trim();
        if (parts[1]) chat.summary = parts[1].replace(')', '').trim();

        chat.history.push({ role: "model", parts: [{ text: fullResponse }] });
        chat.lastUpdate = Date.now();
        await chat.save();

        res.send(`read=t-${cleanResponse}&target=1&next=goto_this_ext`);
    } catch (e) { res.send("read=t-שגיאה בעיבוד"); }
});

app.post('/history', async (req, res) => {
    try {
        const identifier = req.body.ApiUserName || req.body.ApiPhone || "unknown";
        const digits = req.body.Digits;
        let chats = await Chat.find({ identifier }).sort({ lastUpdate: -1 });

        if (chats.length === 0) return res.send("read=t-אין היסטוריה");

        if (digits === '9') {
            await Chat.findByIdAndDelete(chats[0]._id);
            return res.send("read=t-נמחק");
        }

        let chat = (digits === '2' && chats.length > 1) ? chats[1] : chats[0];
        let msg = `שיחה מ${chat.lastUpdate.toLocaleDateString('he-IL')}: ${chat.summary}. לחידוש הקש 1, למחיקה 9.`;
        if (chats.length > 1 && digits !== '2') msg += " לקודמת הקש 2.";

        if (digits === '1') return res.send("next=goto_ext-1");
        res.send(`read=t-${msg}&api_get_digits=1&api_digit_confirm=no`);
    } catch (e) { res.send("read=t-שגיאה"); }
});

async function speechToText(buffer) {
    const formData = new FormData();
    formData.append('file', buffer, { filename: 'audio.wav' });
    formData.append('model', 'whisper-large-v3');
    return axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
        headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` }
    });
}

app.listen(process.env.PORT || 3000);
