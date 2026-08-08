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

app.get('/', (req, res) => {
  res.json({ message: '🚀 MitchBI API is running!', version: '1.0.0', status: 'ok' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Every /api/* route requires a valid Supabase session from here on.
const { requireAuth } = require('./middleware/auth');
app.use('/api', requireAuth);

// Routes
const briefingRoute = require('./routes/briefing');
app.use('/api/briefing', briefingRoute);

const assistantRoute = require('./routes/assistant');
app.use('/api/assistant', assistantRoute);

const connectionsRoute = require('./routes/connections');
app.use('/api/connections', connectionsRoute);

const queryRoute = require('./routes/query');
app.use('/api/query', queryRoute);

const traderRoute = require('./routes/trader');
app.use('/api/trader', traderRoute);

const tradingImperiumRoute = require('./routes/tradingImperium');
app.use('/api/trading-imperium', tradingImperiumRoute);

const epicerieRoute = require('./routes/epicerie');
app.use('/api/epicerie', epicerieRoute);

app.listen(PORT, () => {
  console.log(`✅ MitchBI backend running on port ${PORT}`);
  console.log(`✅ Route /api/briefing enregistrée`);
});
