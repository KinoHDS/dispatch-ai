import express from 'express';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const MISSED_CALL_PROMPT = 'The customer just called and nobody could answer. Write the first text message to them: briefly apologize for missing their call and ask what service they need help with.';
const FALLBACK_REPLY = "Thanks for reaching out! Our team will text you back shortly.";
const MISSED_CALL_FALLBACK = "Sorry we missed your call! Text us what you need and we'll get right back to you.";

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
            model: 'claude-sonnet-5',
            max_tokens: 300,
            thinking: { type: 'disabled' },
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }]
        })
    });
    const data = await response.json();

    const text = (data.content || [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();

    if (!text) {
        console.error("Claude API Error Response:", data);
        throw new Error('Claude API Error: ' + JSON.stringify(data));
    }

    return text;
}

async function sendGHLMessage(apiToken, contactId, messageText) {
    const token = String(apiToken).replace(/^bearer\s+/i, '');
    const response = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            type: 'SMS',
            contactId: contactId,
            message: messageText
        })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(`GHL send failed (${response.status}): ${JSON.stringify(data)}`);
    }
    return data;
}

// GHL fills empty merge fields with the text "undefined" — treat that as no text.
function cleanText(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text === 'undefined' || text === 'null') return '';
    return text;
}

async function handleWebhook(body) {
    const payload = body.customData || {};

    const locationId = payload.locationId || body.location?.id;
    const contactId = payload.contactId || body.contact_id;
    const message = cleanText(payload.message) || cleanText(body.message?.body);
    const eventType = String(payload.event_type || body.event_type || '').trim().toLowerCase();
    const isMissedCall = eventType === 'missed_call' || body.message?.type === 1;

    console.log("Extracted Data:", { locationId, contactId, message, isMissedCall });

    if (!isMissedCall && !message) {
        console.log("Skipping: no message text (not an SMS)");
        return;
    }
    if (!locationId || !contactId) {
        console.error("Skipping: missing locationId or contactId");
        return;
    }

    const config = getLocationConfig(locationId);
    if (!config || !config.apiToken || !config.prompt) {
        console.error(`No usable config for location ${locationId} in LOCATION_KEYS (needs "prompt" and "apiToken")`);
        return;
    }

    let aiReply;
    try {
        aiReply = await callClaude(config.prompt, isMissedCall ? MISSED_CALL_PROMPT : message);
        console.log("Claude reply:", aiReply);
    } catch (error) {
        console.error("Claude failed, sending fallback text:", error.message);
        aiReply = isMissedCall ? MISSED_CALL_FALLBACK : FALLBACK_REPLY;
    }

    const result = await sendGHLMessage(config.apiToken, contactId, aiReply);
    console.log("GHL send OK:", result);
}

app.post('/webhook/handler', (req, res) => {
    console.log("Incoming Webhook Data:", req.body);

    // Answer GHL right away so it doesn't time out and resend the webhook.
    res.status(200).json({ received: true });

    handleWebhook(req.body).catch(error => {
        console.error("Error:", error.message);
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));