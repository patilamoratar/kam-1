const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('node-pty');
const multer = require('multer');

// ========== Configuration ==========
const PORT = 2020;
const HOST = '0.0.0.0';
const BASE_DIR = '/root/';
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-secret-key-change-in-production';
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'password';

if (!fs.existsSync(BASE_DIR)) {
    console.error(`Base directory ${BASE_DIR} does not exist.`);
    process.exit(1);
}

// ========== Express Setup ==========
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ========== Embedded Login Page ==========
const loginPage = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login</title>
    <style>
        body { font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f0f2f5; }
        .login-container { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); width: 90%; max-width: 400px; }
        h2 { margin-top: 0; text-align: center; }
        label { display: block; margin: 1rem 0 0.25rem; }
        input { width: 100%; padding: 0.5rem; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
        button { width: 100%; margin-top: 1.5rem; padding: 0.75rem; background: #1877f2; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
        button:hover { background: #166fe5; }
    </style>
</head>
<body>
    <div class="login-container">
        <h2>Login</h2>
        <form method="POST" action="/login">
            <label>Username</label>
            <input type="text" name="username" required autofocus>
            <label>Password</label>
            <input type="password" name="password" required>
            <button type="submit">Log In</button>
        </form>
    </div>
</body>
</html>
`;

// ========== Auth Helpers ==========
function isAuthenticated(req) {
    return req.session && req.session.auth === true;
}

function requireAuth(req, res, next) {
    if (isAuthenticated(req)) next();
    else res.redirect('/login');
}

// ========== Login Routes ==========
app.get('/login', (req, res) => {
    if (isAuthenticated(req)) return res.redirect('/');
    res.send(loginPage);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === AUTH_USER && password === AUTH_PASS) {
        req.session.auth = true;
        res.redirect('/');
    } else {
        res.send('<h2>Invalid credentials</h2><a href="/login">Try again</a>');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ========== Main Page ==========
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ========== File API (protected) ==========
function safePath(userPath) {
    if (!userPath) return BASE_DIR;
    userPath = userPath.replace(/\0/g, '');
    const resolved = path.resolve(BASE_DIR, userPath);
    if (!resolved.startsWith(BASE_DIR)) throw new Error('Access denied');
    return resolved;
}

// List directory
app.get('/api/files', requireAuth, (req, res) => {
    try {
        const target = safePath(req.query.path || '');
        fs.readdir(target, { withFileTypes: true }, (err, items) => {
            if (err) return res.status(500).json({ error: err.message });
            const files = items.map(item => {
                const fullPath = path.join(target, item.name);
                let stats;
                try { stats = fs.statSync(fullPath); } catch { stats = { size: 0, mtime: new Date() }; }
                return {
                    name: item.name,
                    type: item.isDirectory() ? 'directory' : 'file',
                    size: stats.size,
                    mtime: stats.mtime
                };
            });
            const relative = path.relative(BASE_DIR, target) || '';
            res.json({ path: relative, files });
        });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Download file
app.get('/api/files/download', requireAuth, (req, res) => {
    try {
        const target = safePath(req.query.path || '');
        fs.stat(target, (err, stats) => {
            if (err || !stats.isFile()) return res.status(404).send('File not found');
            res.download(target);
        });
    } catch (e) { res.status(400).send(e.message); }
});

// Upload file
const upload = multer({ dest: os.tmpdir() });
app.post('/api/files/upload', requireAuth, upload.single('file'), (req, res) => {
    try {
        const targetDir = safePath(req.query.path || '');
        if (!fs.statSync(targetDir).isDirectory()) return res.status(400).send('Not a directory');
        if (!req.file) return res.status(400).send('No file');
        const destPath = path.join(targetDir, req.file.originalname);
        fs.rename(req.file.path, destPath, (err) => {
            if (err) {
                const read = fs.createReadStream(req.file.path);
                const write = fs.createWriteStream(destPath);
                read.pipe(write);
                write.on('finish', () => fs.unlink(req.file.path, () => res.json({ success: true })));
                write.on('error', (e) => res.status(500).send(e.message));
            } else res.json({ success: true });
        });
    } catch (e) { res.status(400).send(e.message); }
});

// ========== WebSocket for Terminal ==========
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

io.on('connection', (socket) => {
    const req = socket.request;
    if (!req.session || !req.session.auth) return socket.disconnect(true);

    const cols = parseInt(socket.handshake.query.cols) || 80;
    const rows = parseInt(socket.handshake.query.rows) || 24;
    const shell = process.env.SHELL || 'bash';
    const pty = spawn(shell, [], { name: 'xterm-color', cols, rows, cwd: BASE_DIR, env: process.env });

    pty.on('data', (data) => socket.emit('data', data));
    socket.on('data', (data) => pty.write(data));
    socket.on('resize', (size) => pty.resize(size.cols, size.rows));
    socket.on('disconnect', () => pty.kill());
});

// ========== Start Server ==========
server.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}/`);
    console.log(`Base directory: ${BASE_DIR}`);
    console.log(`Login with ${AUTH_USER} / ${AUTH_PASS}`);
});
