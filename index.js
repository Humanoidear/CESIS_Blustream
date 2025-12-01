const express = require('express');
const ical = require('node-ical');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const http = require('http');
const { start } = require('repl');

const app = express();
const port = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
const skipParse = process.env.SKIP_PARSE === 'true';
// Track scheduled timeouts so we can clear/reschedule on new parses
let scheduledJobs = {};

// Send the POST request to the hardware endpoint to set an output to a given frame/input
function sendOutCommand(outputId, inputId) {
    const cmd = `OUT ${outputId} FR ${inputId}`;
    const query = `?cmd=${encodeURIComponent(cmd)}`;
    const options = {
        hostname: '172.31.17.65',
        port: 80,
        path: `/cgi-bin/submit${query}`,
        method: 'POST',
        headers: {
            'Content-Length': 0
        }
    };

    const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk.toString());
        res.on('end', () => {
            console.log(`${new Date().toISOString()} - Sent '${cmd}' -> ${res.statusCode} ${body ? '- ' + body : ''}`);
        });
    });

    req.on('error', (err) => {
        console.error(`${new Date().toISOString()} - Error sending '${cmd}':`, err.message || err);
    });

    req.end();
}

// Trigger the hardware commands for a single parsed event using its room_mappings
function triggerEventMappings(event) {
    if (!event || !event.rooms || !Array.isArray(event.rooms.room_mappings)) {
        console.log(`${new Date().toISOString()} - No room_mappings for event at ${event && event.start_time}`);
        return;
    }

    console.log(`${new Date().toISOString()} - Triggering hardware for event starting ${event.start_time}`);
    for (const mapping of event.rooms.room_mappings) {
        const out = mapping.output_room && mapping.output_room.id;
        const input = mapping.input_room && mapping.input_room.id;
        if (out == null || input == null) {
            console.warn(`${new Date().toISOString()} - Skipping mapping with missing ids:`, mapping);
            continue;
        }
        // Send one POST per mapping. If the same output maps to multiple inputs, this sends the same OUT with different FR as requested.
        sendOutCommand(out, input);
    }
}

// Schedule triggers for all parsed events. Clears previously scheduled jobs to avoid duplicates.
function scheduleEventTriggers(parsedData) {
    try {
        // clear existing
        for (const key of Object.keys(scheduledJobs)) {
            clearTimeout(scheduledJobs[key]);
        }
        scheduledJobs = {};

        if (!Array.isArray(parsedData)) return;

        parsedData.forEach((ev, idx) => {
            if (!ev || !ev.start_time) return;
            const start = new Date(ev.start_time);
            const now = Date.now();
            const delay = start.getTime() - now;

            // If it already started within the last minute, trigger immediately
            if (delay <= 0) {
                if (now - start.getTime() <= 60_000) {
                    console.log(`${new Date().toISOString()} - Event already started recently; triggering immediately: ${ev.start_time}`);
                    triggerEventMappings(ev);
                }
                return;
            }

            // Avoid scheduling extremely far in the future (e.g., more than 30 days)
            const maxDelay = 30 * 24 * 60 * 60 * 1000;
            if (delay > maxDelay) return;

            const key = `${ev.start_time}-${idx}`;
            scheduledJobs[key] = setTimeout(() => {
                try {
                    triggerEventMappings(ev);
                } catch (err) {
                    console.error(`${new Date().toISOString()} - Error triggering mappings for event ${ev.start_time}:`, err);
                }
                delete scheduledJobs[key];
            }, delay);

            console.log(`${new Date().toISOString()} - Scheduled hardware triggers for ${ev.start_time} (in ${Math.round(delay / 1000)}s)`);
        });
    } catch (err) {
        console.error(`${new Date().toISOString()} - scheduleEventTriggers error:`, err);
    }
}

// Parse iCal and structure events using Gemini AI, then save it to structured_events.json
async function parseICal() {
    console.log(`${new Date().toISOString()} - Starting iCal parsing and structuring process...`);
    const icalUrl = process.env.ICAL_URL;

    const events = await ical.async.fromURL(icalUrl);

    const eventsArray = Object.values(events).map(event => ({
        type: event.type,
        summary: event.summary,
        description: event.description,
        start: event.start,
        end: event.end,
        location: event.location,
        organizer: event.organizer,
        attendees: event.attendee,
        status: event.status,
        uid: event.uid
    }));

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are a calendar event parser. Parse the following iCal events and return a clean, structured JSON array.
There are different classes assigned to an event (inside the event title you can get all the information you need)

Here is an example:
Prácticas PAL Cod.33008. 2.04 Debriefing 1, 2.08 Sala 2, 2.13 Debriefing 4, 2.15 Sala 6. David Hernández
Scheduled: Nov 13, 2025 at 7:00 AM to 10:00 AM, GMT

Each class is either an input or an output. outputs are the classes where the activity will take place, inputs are the classes where the students will view the activity taking place in the output classes.

This is how they look:
	"in": [{
			"id": 1,
			"name": "2.06 SALA 1",
		}, {
			"id": 2,
			"name": "2.08 SALA 2",
		}, {
			"id": 3,
			"name": "2.10 SALA 3",
		}, {
			"id": 4,
			"name": "2.11 SALA4/UCI",
		}, {
			"id": 5,
			"name": "2.12 URGENCIES",
		}, {
			"id": 6,
			"name": "2.15 HOSPITALITZ",
		}, {
			"id": 7,
			"name": "3.10 DOMICILI",
		}, {
			"id": 8,
			"name": "3.12 AMBULANCIA",
		}, {
			"id": 9,
			"name": "3.13 QUIROFAN",
		}, {
			"id": 10,
			"name": "3.14 FISIOTERAP.",
		}],
	"out": [{
			"id": 1,
			"name": "2.04 DEBRIEF. 1",
		}, {
			"id": 2,
			"name": "2.07 DEBRIEF. 2",
		}, {
			"id": 3,
			"name": "2.09 DEBRIEF. 3",
		}, {
			"id": 4,
			"name": "2.13 DEBRIEF. 4",
		}, {
			"id": 5,
			"name": "1.15 DEBRIEF. 5",
		}, {
			"id": 6,
			"name": "2.05 ODONTOLOGIA",
		}, {
			"id": 7,
			"name": "3.11 HABILI. 2-1",
		}, {
			"id": 8,
			"name": "2.18 AULA D'HAB2",
		}, {
			"id": 9,
			"name": "2.01 HABILID. 1",
		}, {
			"id": 10,
			"name": "2.03 REUNIONES",
		}]
}

Nevermind the name, just the code of the room (2.04, 2.08, etc is important)

For each event, extract and structure the following fields:
- Time of the event (start and end in ISO 8601 format)
- Rooms involved (separate input and output rooms based on the class codes) and which inputs map to which outputs, normally they are in order, if there are 2 inputs and 1 output, both inputs map to the single output

This is an example of the expected output:
[
  {
    "start_time": "2025-11-10T07:30:00.000Z",
    "end_time": "2025-11-10T13:30:00.000Z",
    "rooms": {
      "input_rooms": [
        {
          "id": 1,
          "name": "2.06 SALA 1"
        },
        {
          "id": 4,
          "name": "2.11 SALA4/UCI"
        }
      ],
      "output_rooms": [
        {
          "id": 9,
          "name": "2.01 HABILID. 1"
        }
      ],
      "room_mappings": [
        {
          "input_room": {
            "id": 1,
            "name": "2.06 SALA 1"
          },
          "output_room": {
            "id": 9,
            "name": "2.01 HABILID. 1"
          }
        },
        {
          "input_room": {
            "id": 4,
            "name": "2.11 SALA4/UCI"
          },
          "output_room": {
            "id": 9,
            "name": "2.01 HABILID. 1"
          }
        }
      ]
    }
  }
]

Events data:
${JSON.stringify(eventsArray, null, 2)}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let structuredData = response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsedData = JSON.parse(structuredData);

    const outputDir = path.join(__dirname, 'json');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }
    const outputPath = path.join(outputDir, 'structured_events.json');
    fs.writeFileSync(outputPath, JSON.stringify(parsedData, null, 2));
    console.log(`${new Date().toISOString()} -  Structured events saved to ${outputPath}`);

    // Schedule hardware triggers for the parsed events
    try {
        scheduleEventTriggers(parsedData);
    } catch (err) {
        console.error(`${new Date().toISOString()} - Failed to schedule event triggers:`, err);
    }

    // Invalidate cache to force reload on next request
    cacheTimestamp = null;

    return { originalEventCount: eventsArray.length, structuredEvents: parsedData };
}

app.listen(port, () => {
    console.log(`CESIS Bluestream Server listening on port ${port}`);
});

// On startup, attempt to schedule triggers from existing structured_events.json so triggers run even if AI parsing is skipped
try {
    const existingPath = path.join(__dirname, 'json', 'structured_events.json');
    if (fs.existsSync(existingPath)) {
        const raw = fs.readFileSync(existingPath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            scheduleEventTriggers(data);
            console.log(`${new Date().toISOString()} - Scheduled events from existing ${existingPath}`);
        } else {
            console.warn(`${new Date().toISOString()} - Existing structured_events.json is not an array; skipping scheduling.`);
        }
    } else {
        console.log(`${new Date().toISOString()} - No existing structured_events.json to load on startup.`);
    }
} catch (err) {
    console.error(`${new Date().toISOString()} - Error loading existing structured_events.json:`, err);
}

// Initial and recurring iCal parsing job
if (!skipParse) {
    parseICal().catch(err => console.error('Startup iCal processing failed:', err));
    cron.schedule('0 0 * * 0', () => {
        parseICal().catch(err => console.error('Scheduled iCal processing failed:', err));
    });
}