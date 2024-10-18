const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const si = require('systeminformation');
const sqlite3 = require('sqlite3').verbose();
const exec = require('child_process').spawn;


const app = express();
app.use(express.json());
app.use(express.static('public'));

const port = 3900;
const configPath = path.join(__dirname, 'config.json');
let matchmaker = {};
let network = {};
let game = {};
let servers = [];

// SQLite database initialization
let db = new sqlite3.Database('./metrics.db', (err) => {
    if (err) console.error('Error connecting to SQLite database:', err);
    else console.log('Connected to SQLite database.');
});

// Create table for storing system metrics
db.run(`
    CREATE TABLE IF NOT EXISTS machine_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        cpu_load REAL,
        memory_used REAL,
        memory_total REAL,
        gpu_vram_used REAL,
        gpu_vram_total REAL
    )
`);

// Load server configurations from config.json
function loadServers() {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        matchmaker = config.matchmaker;
        network = config.network;
        game = config.game;  // Load game path and executable
        servers = config.servers.map(server => ({
            ...server,
            publicIp: network.publicIp,
            localIp: network.localIp,
            signalingProcess: null,  // Track signaling process
            gameProcess: null  // Track game process
        }));
        console.log('Servers loaded from config.json:', servers);
    } catch (error) {
        console.error('Error loading config.json:', error);
    }
}
loadServers();

// Store system metrics in the database every 5 seconds
function storeSystemMetrics() {
    si.currentLoad()
        .then(cpu => si.mem()
            .then(memory => si.graphics()
                .then(gpu => {
                    const timestamp = Math.floor(Date.now() / 1000);
                    const gpuData = gpu.controllers.length > 0 ? gpu.controllers[0] : { memoryUsed: 0, vram: 0 };
                    db.run(`
                        INSERT INTO machine_stats (timestamp, cpu_load, memory_used, memory_total, gpu_vram_used, gpu_vram_total)
                        VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            timestamp,
                            cpu.currentLoad.toFixed(2),
                            (memory.used / 1024 / 1024 / 1024).toFixed(2),  // Convert to GB
                            (memory.total / 1024 / 1024 / 1024).toFixed(2),  // Convert to GB
                            gpuData.memoryUsed ? (gpuData.memoryUsed / 1024).toFixed(2) : 0,  // Convert to GB
                            gpuData.vram ? (gpuData.vram / 1024).toFixed(2) : 0  // Convert to GB
                        ]
                    );
                })
            )
        )
        .catch(error => console.error('Error storing system metrics:', error));
}

// Clean old data (keep only the last 180 entries)
function cleanOldMetrics() {
    db.run(
        `DELETE FROM machine_stats 
         WHERE id NOT IN (
            SELECT id FROM machine_stats ORDER BY timestamp DESC LIMIT 180
         )`
    );
}

// Periodically store system metrics and clean old entries
setInterval(() => {
    storeSystemMetrics();
    cleanOldMetrics();
}, 5000);

// API to get the current status of all servers
app.get('/server-status', (req, res) => {
    const statuses = servers.map(server => ({
        name: server.name,
        status: server.signalingProcess && server.gameProcess ? 'running' : 'stopped',
        publicIp: server.publicIp,
        publicDomain: server.publicDomain,
        localIp: server.localIp,
        httpPort: server.httpPort
    }));
    res.json(statuses);
});
function startServerAndGame(server) {
    // Start signaling server process
    server.signalingProcess = spawn('node', [
        'C:/Users/vigne/Documents/signallingservers/SignallingWebServer/cirrus.js',
        '--UseMatchmaker', 'true',
        '--MatchmakerAddress', matchmaker.address,
        '--MatchmakerPort', matchmaker.port,
        '--PublicIp', server.publicIp,
        '--HttpPort', server.httpPort,
        '--StreamerPort', server.streamerPort,
        '--SFUPort', server.sfuPort
    ]);

    console.log(`${server.name} signaling server started on port ${server.httpPort}`);

    server.signalingProcess.stdout.on('data', (data) => {
        console.log(`[${server.name}] signaling stdout: ${data}`);
    });

    server.signalingProcess.stderr.on('data', (data) => {
        console.error(`[${server.name}] signaling stderr: ${data}`);
    });

    server.signalingProcess.on('close', (code) => {
        console.log(`${server.name} signaling server stopped with code ${code}`);
        server.signalingProcess = null;  // Mark the signaling server as stopped
    });

    // Start game process and track PID
    server.gameProcess = spawn(path.join(game.path, game.exe), server.gameArgs.split(' '));
    server.gamePID = server.gameProcess.pid;  // Track the PID of the game process

    console.log(`${server.name} game started with PID: ${server.gamePID} and args: ${server.gameArgs}`);

    server.gameProcess.stdout.on('data', (data) => {
        console.log(`[${server.name}] game stdout: ${data}`);
    });

    server.gameProcess.stderr.on('data', (data) => {
        console.error(`[${server.name}] game stderr: ${data}`);
    });

    server.gameProcess.on('close', (code) => {
        console.log(`${server.name} game stopped with code ${code}`);
        server.gameProcess = null;  // Mark the game as stopped
        server.gamePID = null;  // Clear the PID
    });
}
// API to start a specific server (both signaling server and game)
app.post('/start', (req, res) => {
    const { name } = req.body;
    const server = servers.find(s => s.name === name);
    if (server) {
        if (server.signalingProcess && server.gameProcess) {
            return res.json({ error: `${name} is already running` });
        }
        startServerAndGame(server);  // Start both processes
        res.json({ message: `${name} started` });
    } else {
        res.status(404).json({ error: 'Server not found' });
    }
});
// Function to kill a process using taskkill
function killProcessByPID(pid, callback) {
    // Using exec to run the taskkill command (string input)
    exec("taskkill", ["/pid", pid, '/f', '/t']);
    console.log(`Process ${pid} killed successfully.`);
    callback();
}

// Function to kill a process by name using WMIC and taskkill
function killGameProcessByName(gameExe, callback) {
    // Using exec to fetch PIDs using WMIC for the given executable name
    exec(`wmic process where name="${gameExe}" get processid`, (error, stdout, stderr) => {
        if (error || stderr) {
            console.error(`Error fetching process PID for ${gameExe}:`, stderr || error);
            if (callback) callback();  // Ensure callback is invoked
        } else {
            // Extract PIDs from the output using regex to match numbers
            const pids = stdout.match(/\d+/g);
            if (pids) {
                // For each PID, call killProcessByPID to kill the process
                pids.forEach(pid => {
                    killProcessByPID(pid, callback);
                });
            } else {
                console.log(`No running process found for ${gameExe}`);
                if (callback) callback();
            }
        }
    });
}

// API to stop a specific server (both signaling server and game)
app.post('/stop', (req, res) => {
    const { name } = req.body;
    const server = servers.find(s => s.name === name);
    if (server) {
        if (!server.signalingProcess && !server.gameProcess) {
            return res.json({ error: `${name} is not running` });
        }

        // Stop the signaling process
        if (server.signalingProcess) {
            server.signalingProcess.kill('SIGTERM');  // Default termination signal for signaling server
            console.log(`${server.name} signaling server stopped`);
            server.signalingProcess = null;
        }

        // Stop the game process using taskkill or WMIC
        if (server.gameProcess) {
            if (server.gamePID) {
                // If PID is known, kill using taskkill
                killProcessByPID(server.gamePID, () => {
                    server.gameProcess = null;
                    server.gamePID = null;
                    res.json({ message: `${name} stopped` });
                });
            } else {
                // If PID is not tracked, use WMIC to find the game by executable name
                killGameProcessByName(game.exe, () => {
                    server.gameProcess = null;
                    server.gamePID = null;
                    res.json({ message: `${name} stopped` });
                });
            }
        } else {
            res.json({ message: `${name} stopped` });
        }
    } else {
        res.status(404).json({ error: 'Server not found' });
    }
});


// API to restart a specific server (both signaling server and game)
app.post('/restart', (req, res) => {
    const { name } = req.body;
    const server = servers.find(s => s.name === name);
    if (server) {
        if (server.signalingProcess) {
            server.signalingProcess.kill('SIGTERM');  // Stop signaling server
            console.log(`${server.name} signaling server stopped for restart`);
            server.signalingProcess = null;
        }
        if (server.gameProcess) {
            server.gameProcess.kill('SIGKILL');  // Force stop game process
            console.log(`${server.name} game stopped for restart`);
            server.gameProcess = null;
        }
        // Restart both signaling server and game
        startServerAndGame(server);
        res.json({ message: `${name} restarted` });
    } else {
        res.status(404).json({ error: 'Server not found' });
    }
});

// API to get real-time system stats
app.get('/system-stats', (req, res) => {
    si.currentLoad()
        .then(cpu => si.mem()
            .then(memory => si.graphics()
                .then(gpu => {
                    const gpuData = gpu.controllers.length > 0 ? gpu.controllers[0] : { memoryUsed: 0, vram: 0 };
                    res.json({
                        cpu: cpu.currentLoad.toFixed(2),
                        memory: {
                            used: (memory.used / 1024 / 1024 / 1024).toFixed(2),  // Convert to GB
                            total: (memory.total / 1024 / 1024 / 1024).toFixed(2)  // Convert to GB
                        },
                        gpu: {
                            vramUsed: gpuData.memoryUsed ? (gpuData.memoryUsed / 1024).toFixed(2) : 0,  // Convert to GB
                            vramTotal: gpuData.vram ? (gpuData.vram / 1024).toFixed(2) : 0  // Convert to GB
                        }
                    });
                })
            )
        )
        .catch(error => {
            console.error('Error fetching system stats:', error);
            res.status(500).json({ error: 'Failed to fetch system stats' });
        });
});

// API to get historical system metrics (last 15 minutes)
app.get('/get-metrics', (req, res) => {
    db.all('SELECT * FROM machine_stats WHERE timestamp >= strftime("%s", "now") - 900 ORDER BY timestamp ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Start the server on port 3900
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
