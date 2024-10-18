const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('Worker App Online');
});

app.listen(3200, () => {
    console.log('Worker App listening on port 3200');
});