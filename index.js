import express from 'express';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const getLocationConfig = (locationId) => {
    try {
        const keys = JSON.parse(process.env.LOCATION_KEYS || '{}');
        return keys[locationId] || null;
    } catch (e) {
        console.error("Failed to parse LOCATION_KEYS:", e);
        return null;
    }
};

async function callClaude(systemPrompt, userMessage) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 300,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }]
        })
    });
    const data = await response.json();
    
    // THIS LINE WILL PRINT THE REAL ANTHROPIC ERROR TO YOUR LOGS:
    if (!data.content || !data.content[0]) {
        console.error("Claude API Error Response:", data);
        throw new Error('Claude API Error: ' + JSON.stringify(data));
    }
    
    return data.content[0].text;
}

async function sendGHLMessage(apiToken, contactId, phone, messageText) {
    const response = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            type: 'SMS',
            contactId: contactId,
            phone: phone,
            message: messageText
        })
    });
    return await response.json();
}

app.post('/webhook/handler', async (req, res) => {
    try {
        console.log("Incoming Webhook Data:", req.body);

        // Pull from customData object sent by GHL
        const payload = req.body.customData || req.body;

        const locationId = payload.locationId || req.body.location?.id;
        const contactId = payload.contactId || req.body.contact_id;
        const phone = payload.phone || req.body.phone;
        const message = typeof payload.message === 'string' ? payload.message : req.body.message?.body;

        console.log("Extracted Data:", { locationId, contactId, phone, message });

        if (!locationId) return res.status(400).json({ error: 'Missing locationId' });

        const config = getLocationConfig(locationId);
        if (!config) return res.status(404).json({ error: 'No config found' });

        const incomingText = message || "Hi, I missed your call. What service do you need help with today?";
        const aiReply = await callClaude(config.prompt, incomingText);
        await sendGHLMessage(config.apiToken, contactId, phone, aiReply);

        res.status(200).json({ success: true, replySent: aiReply });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));