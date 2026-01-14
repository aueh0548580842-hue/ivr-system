const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const { GROQ_API_KEY, GEMINI_API_KEY, MONGO_URI } = process.env;
mongoose.connect(MONGO_URI);

const ChatSchema = new mongoose.Schema({
    identifier: String,
    userName: String,
    history: Array,
    createdAt: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

app.post('/ivr', async (req, res) => {
    const phone = req.body.ApiPhone || "unknown";
    const apiUserName = req.body.ApiUserName || "";
    const identifier = phone; // מזהה לפי טלפון לצורך אחידות
    const extension = req.body.ApiExtension;
    const digits = req.body.digits;
    let skip = parseInt(req.query.skip || 0);

    // --- שלוחה 1: שיחה חדשה ---
    if (extension === "1") {
        if (!req.body.file_url && !req.query.file_url) {
            return res.send(getRecordCommand());
        }
        return await handleChat(req, res, identifier, apiUserName, true);
    }

    // --- שלוחה 2: היסטוריה ---
    if (extension === "2") {
        const chats = await Chat.find({ identifier }).sort({ createdAt: -1 }).skip(skip).limit(1);
        if (!chats.length) return res.send("read=t-אין שיחות נוספות.&next=goto_main");

        const currentChat = chats[0];
        if (digits === "1") return await handleChat(req, res, identifier, apiUserName, false, currentChat._id);
        if (digits === "2") return res.send(`next=goto_this_ext?skip=${skip + 1}`);
        if (digits === "9") {
            await Chat.findByIdAndDelete(currentChat._id);
            return res.send("read=t-השיחה נמחקה.&next=goto_this_ext");
        }

        const lastMsg = currentChat.history[currentChat.history.length - 1].parts[0].text.replace(/[&?]/g, ' ');
        return res.send(`read=t-שיחה אחרונה: ${lastMsg}. להמשך הקש 1, לישנה יותר 2, למחיקה 9.&max_digits=1&next=goto_this_ext?skip=${skip}`);
    }
});

async function handleChat(req, res, identifier, userName, isNew, chatId = null) {
    const audioUrl = req.body.file_url || req.query.file_url;
    if (!audioUrl) return res.send(getRecordCommand());

    try {
        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const transcription = await speechToText(audioRes.data);
        const userText = transcription.data.text;

        let chat;
        if (isNew || !chatId) {
            chat = new Chat({ identifier, userName, history: [] });
        } else {
            chat = await Chat.findById(chatId);
        }

        chat.history.push({ role: "user", parts: [{ text: userText }] });

        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: chat.history,
            system_instruction: { parts: [{ text: `שם המשתמש: ${userName}. ענה בקצרה רבה מאוד.` }] }
        });

        const reply = geminiRes.data.candidates[0].content.parts[0].text;
        chat.history.push({ role: "model", parts: [{ text: reply }] });
        await chat.save();

        return res.send(`read=t-${reply.replace(/[&?]/g, ' ')}&next=goto_this_ext${!isNew ? `?chatId=${chat._id}` : ''}`);
    } catch (e) {
        return res.send("read=t-חלה שגיאה.&next=goto_main");
    }
}

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
