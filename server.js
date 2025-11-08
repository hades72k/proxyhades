import express from "express";
import fetch from "node-fetch"; // fetch Roblox URLs

const app = express();

// Allow CORS so Roblox Studio can fetch
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
});

// Proxy route
app.get("/proxy", async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    try {
        const response = await fetch(targetUrl, {
            headers: {
                "User-Agent": "RobloxStudio/WinInet"
            }
        });
        const text = await response.text();
        res.send(text);
    } catch (err) {
        res.status(500).send(err.toString());
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
});
