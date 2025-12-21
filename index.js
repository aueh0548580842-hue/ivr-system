const express = require('express');
const app = express();

app.use(express.json());

app.get('/ivr', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send("read=t-השרת החדש ב-Render מחובר בהצלחה.&next=hangup");
});

app.get('/', (req, res) => {
    res.send("Server is Online");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});