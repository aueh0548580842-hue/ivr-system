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
    const identifier = phone; 
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

    // --- שלוחה 2 (רגילה): היסטוריה אישית ---
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

    // --- שלוחה 0/2: שלוחת מנהל (סיכום שיחות) ---
    // שינוי לבקשתך: השלוחה הזו מרכזת את כל שיחות המערכת עם סיכום AI
    if (extension === "0/2" || (extension === "2" && req.body.ApiFolder === "0")) {
        const adminPhone = "0534190819"; // עדכן למספר הטלפון שלך
        if (phone !== adminPhone) {
            return res.send("read=t-אין לך הרשאה לגשת לשלוחה זו.&next=goto_main");
        }

        const allChats = await Chat.find({}).sort({ createdAt: -1 }).skip(skip).limit(1);
        if (!allChats.length) return res.send("read=t-אין הודעות נוספות במערכת.&next=goto_main");

        const currentChat = allChats[0];
        
        try {
            const summaryRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
                contents: currentChat.history,
                system_instruction: { 
                    parts: [{ text: "סכם את עיקרי השיחה הזו במשפט אחד קצר וברור עבור המנהל. התמקד בבקשת המשתמש ובתשובה שניתנה." }] 
                }
            });

            const summary = summaryRes.data.candidates[0].content.parts[0].text;
            return res.send(`read=t-שיחה מ${currentChat.identifier}: ${summary.replace(/[&?]/g, ' ')}. לסיכום הבא הקש 2.&max_digits=1&next=goto_this_ext?skip=${skip + 1}`);
        } catch (e) {
            return res.send(`read=t-שגיאה בסיכום השיחה. לשיחה הבאה הקש 2.&next=goto_this_ext?skip=${skip + 1}`);
        }
    }
});

async function handleChat(req, res, identifier, userName, isNew, chatId = null) {
    const audioUrl = req.body.file_url || req.query.file_url;
    if (!audioUrl) return res.send(getRecordCommand());

    try {
        const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const transcription = await speechToText(audioRes.data);
        const userText = transcription.data.text;

        let chat = (isNew || !chatId) ? new Chat({ identifier, userName, history: [] }) : await Chat.findById(chatId);
        chat.history.push({ role: "user", parts: [{ text: userText }] });

        const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: chat.history,
            system_instruction: { 
                parts: [{ text: `שם המשתמש: ${userName}. ענה בצורה ממוקדת. ענה אך ורק על פי גדרי ההלכה והחוק, והימנע מתכנים שאינם הולמים רוח זו.` }] 
            },
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_LOW_AND_ABOVE" }
            ]
        });

        const candidate = geminiRes.data.candidates[0];
        if (candidate.finishReason === "SAFETY") {
            return res.send("read=t-מצטער, התוכן אינו הולם את כללי המערכת.&next=goto_main");
        }

        const reply = candidate.content.parts[0].text;
        chat.history.push({ role: "model", parts: [{ text: reply }] });
        await chat.save();

        return res.send(`read=t-${reply.replace(/[&?]/g, ' ')}&next=goto_this_ext${!isNew ? `?chatId=${chat._id}` : ''}`);
    } catch (e) {
        return res.send("read=t-חלה שגיאה בעיבוד.&next=goto_main");
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
