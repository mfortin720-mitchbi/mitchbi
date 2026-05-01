const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

/*app.use(cors({
  origin: ['http://localhost:5173', 'https://mitchbi.com', 'https://www.mitchbi.com'],
  credentials: true
}));
*/
app.use(cors());

app.use(express.json());

// Routes
const briefingRoute = require('./routes/briefing');
app.use('/api/briefing', briefingRoute);

const assistantRoute = require('./routes/assistant');
app.use('/api/assistant', assistantRoute);

const connectionsRoute = require('./routes/connections');
app.use('/api/connections', connectionsRoute);

const queryRoute = require('./routes/query');
app.use('/api/query', queryRoute);

const authRoute = require('./routes/auth');
const invoicesRoute = require('./routes/invoices');
app.use('/api/auth', authRoute);
app.use('/api/invoices', invoicesRoute);

const traderRoute = require('./routes/trader');
app.use('/api/trader', traderRoute);

app.get('/', (req, res) => {
  res.json({ message: '🚀 MitchBI API is running!', version: '1.0.0', status: 'ok' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ MitchBI backend running on port ${PORT}`);
  console.log(`✅ Route /api/briefing enregistrée`);
});