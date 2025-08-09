"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const routes_js_1 = require("./routes.js");
const cors_1 = __importDefault(require("cors"));
require("dotenv/config");
const app = (0, express_1.default)();
// Configuração CORS para produção
const allowedOrigins = [
  'http://localhost:5173', // desenvolvimento local (Vite)
  'http://localhost:5000', // desenvolvimento backend local
  'https://nectix.netlify.app', // seu frontend em produção
];

app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        // Permite requisições sem origin (aplicativos mobile, Postman, etc.)
        if (!origin)
            return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        // Em produção, você pode ser mais restritivo
        const msg = `Origin ${origin} não permitida pelo CORS`;
        return callback(new Error(msg), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    optionsSuccessStatus: 200
}));
// Middleware para parsing de JSON
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0'
    });
});
// Middleware para log de requisições API
app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse = undefined;
    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
        capturedJsonResponse = bodyJson;
        return originalResJson.apply(res, [bodyJson, ...args]);
    };
    res.on("finish", () => {
        const duration = Date.now() - start;
        if (path.startsWith("/api")) {
            let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
            if (capturedJsonResponse) {
                logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
            }
            if (logLine.length > 200) {
                logLine = logLine.slice(0, 199) + "…";
            }
            console.log(logLine);
        }
    });
    next();
});
(async () => {
    try {
        const server = await (0, routes_js_1.registerRoutes)(app);
        // Middleware para tratamento de erros
        app.use((err, _req, res, _next) => {
            const status = err.status || err.statusCode || 500;
            const message = err.message || "Internal Server Error";
            console.error(`❌ Erro ${status}:`, message);
            if (process.env.NODE_ENV === 'development') {
                console.error(err.stack);
            }
            res.status(status).json({
                error: message,
                ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
            });
        });
        // 404 handler
        app.use('*', (req, res) => {
            res.status(404).json({
                error: 'Endpoint não encontrado',
                path: req.originalUrl,
                method: req.method
            });
        });
        // Porta configurável via ambiente (Render usa PORT)
        const port = process.env.PORT || 5000;
        const host = process.env.HOST || '0.0.0.0';
        server.listen(port, host, () => {
            console.log(`🚀 Servidor rodando em ${host}:${port}`);
            console.log(`📍 Health check: http://${host}:${port}/health`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        });
        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log('🛑 SIGTERM recebido, fechando servidor...');
            server.close(() => {
                console.log('✅ Servidor fechado com sucesso');
                process.exit(0);
            });
        });
        process.on('SIGINT', () => {
            console.log('🛑 SIGINT recebido, fechando servidor...');
            server.close(() => {
                console.log('✅ Servidor fechado com sucesso');
                process.exit(0);
            });
        });
    }
    catch (error) {
        console.error('❌ Erro fatal ao iniciar servidor:', error);
        process.exit(1);
    }
})();
