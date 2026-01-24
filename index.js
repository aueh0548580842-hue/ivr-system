const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// משיכת מפתחות ממשתני הסביבה ב-Render
const { 
    GROQ_API_KEY, 
    GEMINI_API_KEY, 
    MONGO_URI, 
    ELEVENLABS_API_KEY, 
    AGENT_ID 
} = process.env;

mongoose.connect(MONGO_URI);

const ChatSchema = new mongoose.Schema({
    identifier: String,
    history: Array,
    summary: { type: String, default: "" },
    lastUpdate: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

app.post('/ivr', async (req, res) => {
    const phone = req.body.ApiPhone || "unknown";
    const identifier = req.body.ApiPhone || req.body.ApiUserName || "unknown";
    const extension = req.body.ApiExtension;
    const digits = req.body.digits || req.body.Digits;

    try {
        // --- שלוחה 1: שיחה חדשה (הקלטה) ---
        if (extension === "1") {
            const audioUrl = req.body.file_url || req.query.file_url || req.body.FileUrl;
            if (!audioUrl) return res.send(getRecordCommand());

            const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
            const transcription = await speechToText(audioRes.data);
            const userText = transcription.data.text;

            let chat = new Chat({ identifier, history: [] });
            chat.history.push({ role: "user", parts: [{ text: userText }] });

            const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
                contents: chat.history,
                system_instruction: { 
                    parts: [{ text: "ענה בקצרה וביציבות. הוסף בסוף (סיכום: נושא השיחה במקסימום 4 מילים)." }] 
                }
            });

            const fullResponse = geminiRes.data.candidates[0].content.parts[0].text;
            const parts = fullResponse.split('(סיכום:');
            const cleanResponse = parts[0].trim();
            if (parts[1]) chat.summary = parts[1].replace(')', '').trim();

            chat.history.push({ role: "model", parts: [{ text: fullResponse }] });
            await chat.save();

            return res.send(`read=t-${cleanResponse.replace(/[&?]/g, ' ')}&next=goto_main`);
        }

        // --- שלוחה 2: היסטוריה מורחבת (עד 999 שיחות) ---
        if (extension === "2" && req.body.ApiFolder !== "0") {
            const chats = await Chat.find({ identifier }).sort({ lastUpdate: -1 }).limit(999);
            if (chats.length === 0) return res.send("read=t-אין היסטוריה רשומה.&next=goto_main");

            // בחירת שיחה לפי מספר
            if (digits && parseInt(digits) > 0 && parseInt(digits) <= chats.length) {
                const selectedChat = chats[parseInt(digits) - 1];
                const lastMsg = selectedChat.history[selectedChat.history.length - 1].parts[0].text.replace(/[&?]/g, ' ');
                
                if (req.query.action === 'delete') {
                    await Chat.findByIdAndDelete(selectedChat._id);
                    return res.send("read=t-השיחה נמחקה.&next=goto_this_ext");
                }
                
                return res.send(`read=t-בחרת בשיחה ${digits}. התוכן היה: ${lastMsg}. למחיקה הקש 9, לחזרה לתפריט הקש 0.&max_digits=1&next=goto_this_ext?digits=${digits}&action=${digits === '9' ? 'delete' : ''}`);
            }

            // תפריט הקראת שיחות
            let menuText = `נמצאו ${chats.length} שיחות. `;
            const displayLimit = Math.min(chats.length, 5);
            for (let i = 0; i < displayLimit; i++) {
                menuText += `שיחה ${i + 1}: ${chats[i].summary || "ללא נושא"}. `;
            }
            menuText += "הקש את מספר השיחה המבוקש וסולמית לסיום.";
            return res.send(`read=t-${menuText}&max_digits=3&next=goto_this_ext`);
        }

        // --- שלוחה 0/2: שלוחת מנהל ---
        if (extension === "0/2" || (extension === "2" && req.body.ApiFolder === "0")) {
            const adminPhone = "0534190819"; // שנה למספר שלך
            if (phone !== adminPhone) return res.send("read=t-גישה חסומה.&next=goto_main");

            const allChats = await Chat.find({}).sort({ lastUpdate: -1 }).limit(10);
            let adminMsg = "שיחות אחרונות במערכת: ";
            allChats.forEach((c, i) => adminMsg += `שיחה ${i+1} ממספר ${c.identifier}: ${c.summary}. `);
            return res.send(`read=t-${adminMsg}&next=goto_main`);
        }

    } catch (e) {
        console.error(e);
        res.send("read=t-חלה שגיאה במערכת. נסה שוב מאוחר יותר.");
    }
});

function getRecordCommand() {
    return "type=record&record_name=R1&record_ok=no&record_ask_ok=no&record_finish_messages=no&say_record_menu=no&record_beep=yes&record_end_time_if_silent=3&next=goto_this_ext";
}

async function speechToText(buffer) {
    const formData = new FormData();
    formData.append('file', buffer, { filename: 'audio.wav' });
    formData.append('model', 'whisper-large-v3');
    return axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
        headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${GROQ_API_KEY}` }
    });
}

app.listen(process.env.PORT || 3000);
