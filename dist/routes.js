"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const http_1 = require("http");
const supabase_js_1 = require("@supabase/supabase-js");
const mercadopago_1 = require("mercadopago");
const zod_1 = require("zod");
// Função auxiliar para retry com backoff
async function retryWithBackoff(fn, maxRetries = 3, delay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        }
        catch (error) {
            if (i === maxRetries - 1)
                throw error;
            await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
        }
    }
    throw new Error("Max retries exceeded");
}
// Validação dos dados de entrada para pagamento
const createPaymentSchema = zod_1.z.object({
    carrinho: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]),
        name: zod_1.z.string(),
        price: zod_1.z.union([zod_1.z.number(), zod_1.z.string()]).optional().transform(val => {
            if (val === undefined)
                return undefined;
            const num = typeof val === 'string' ? parseFloat(val) : val;
            if (isNaN(num))
                throw new Error("Preço inválido");
            return num;
        }),
        quantity: zod_1.z.number().min(1, "Quantidade deve ser maior que zero")
    })),
    nomeCliente: zod_1.z.string().min(1, "Nome do cliente é obrigatório"),
    email: zod_1.z.string().email("Email inválido"),
    total: zod_1.z.union([zod_1.z.number(), zod_1.z.string()]).transform(val => {
        const num = typeof val === 'string' ? parseFloat(val) : val;
        if (isNaN(num) || num <= 0) {
            throw new Error("Total deve ser um número maior que zero");
        }
        return num;
    })
});
async function registerRoutes(app) {
    // Configuração do Supabase
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    console.log(`🔧 Configuração do Supabase:`);
    console.log(`URL: ${supabaseUrl ? "✅ Configurada" : "❌ Não configurada"}`);
    console.log(`KEY: ${supabaseKey ? "✅ Configurada" : "❌ Não configurada"}`);
    if (!supabaseUrl || !supabaseKey) {
        console.warn(`⚠️ Supabase não configurado. Algumas funcionalidades podem não funcionar.`);
    }
    const supabase = supabaseUrl && supabaseKey ? (0, supabase_js_1.createClient)(supabaseUrl, supabaseKey) : null;
    // Configuração do Mercado Pago
    const mercadoPagoAccessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    console.log(`💳 Mercado Pago: ${mercadoPagoAccessToken ? "✅ Configurado" : "❌ Não configurado"}`);
    if (!mercadoPagoAccessToken) {
        console.error(`❌ MERCADO_PAGO_ACCESS_TOKEN não configurado. Pagamentos não funcionarão.`);
    }
    const client = mercadoPagoAccessToken ? new mercadopago_1.MercadoPagoConfig({
        accessToken: mercadoPagoAccessToken,
        options: { timeout: 10000 }
    }) : null;
    const payment = client ? new mercadopago_1.Payment(client) : null;
    // ROTA: GET /api/status - Status da API
    app.get("/api/status", (req, res) => {
        res.json({
            status: "online",
            timestamp: new Date().toISOString(),
            services: {
                mercadoPago: !!payment,
                supabase: !!supabase
            },
            environment: process.env.NODE_ENV || 'development'
        });
    });
    // ROTA: POST /api/payments/criar-pagamento - Para o frontend
    app.post("/api/payments/criar-pagamento", async (req, res) => {
        try {
            console.log(`🛒 Dados recebidos do carrinho:`, JSON.stringify(req.body, null, 2));
            // Validar dados de entrada
            const validation = createPaymentSchema.safeParse(req.body);
            if (!validation.success) {
                console.error(`❌ Erro de validação:`, validation.error.errors);
                return res.status(400).json({
                    error: "Dados inválidos",
                    details: validation.error.errors
                });
            }
            const { carrinho, nomeCliente, email, total } = validation.data;
            if (!payment) {
                return res.status(503).json({
                    error: "Serviço de pagamento indisponível",
                    details: "Mercado Pago não configurado. Configure MERCADO_PAGO_ACCESS_TOKEN."
                });
            }
            // Criar descrição baseada no carrinho
            const firstItem = carrinho[0];
            const itemName = firstItem.name;
            const description = carrinho.length === 1
                ? itemName
                : `Compra de ${carrinho.length} produtos - ${itemName} e outros`;
            const paymentData = {
                transaction_amount: total,
                description: description,
                payment_method_id: "pix",
                payer: {
                    email: email,
                    first_name: nomeCliente,
                },
                metadata: {
                    carrinho: carrinho.map(item => ({
                        produto_id: item.id,
                        nome: item.name,
                        quantidade: item.quantity
                    })),
                    cliente: nomeCliente,
                    email: email,
                    total_itens: carrinho.length
                }
            };
            console.log(`💳 Criando pagamento PIX:`, {
                amount: total,
                description,
                email,
                cliente: nomeCliente,
                items_count: carrinho.length
            });
            const paymentResponse = await retryWithBackoff(() => payment.create({ body: paymentData }), 3, 1000);
            if (!paymentResponse) {
                return res.status(500).json({
                    error: "Erro ao criar pagamento no Mercado Pago"
                });
            }
            // Extrair informações do pagamento
            const paymentInfo = {
                id: paymentResponse.id,
                status: paymentResponse.status,
                qr_code: paymentResponse.point_of_interaction?.transaction_data?.qr_code || null,
                qr_code_base64: paymentResponse.point_of_interaction?.transaction_data?.qr_code_base64 || null,
                ticket_url: paymentResponse.point_of_interaction?.transaction_data?.ticket_url || null,
                total: total,
                cliente: nomeCliente,
                produtos: carrinho.map(item => ({
                    id: item.id,
                    nome: item.name,
                    quantidade: item.quantity
                }))
            };
            console.log(`✅ Pagamento criado com sucesso:`, {
                id: paymentInfo.id,
                status: paymentInfo.status,
                qr_code_exists: !!paymentInfo.qr_code
            });
            res.json(paymentInfo);
        }
        catch (error) {
            console.error(`❌ Erro ao criar pagamento:`, error);
            res.status(500).json({
                error: "Erro interno do servidor",
                details: error instanceof Error ? error.message : "Erro desconhecido"
            });
        }
    });
    // WEBHOOK: POST /api/payments/webhook - Recebe notificações do Mercado Pago
    app.post("/api/payments/webhook", async (req, res) => {
        try {
            console.log(`🔔 Webhook recebido:`, JSON.stringify(req.body, null, 2));
            const { data, type } = req.body;
            // Verificar se é uma notificação de pagamento
            if (type === "payment" && data?.id) {
                const paymentId = data.id;
                if (!payment) {
                    console.error(`❌ Mercado Pago não configurado para processar webhook`);
                    return res.status(503).json({ error: "Mercado Pago não configurado" });
                }
                // Buscar dados completos do pagamento com retry
                const paymentDetails = await retryWithBackoff(() => payment.get({ id: paymentId }), 3, 2000);
                console.log(`📊 Status do pagamento ${paymentId}:`, paymentDetails.status);
                // Se pagamento foi aprovado, entregar os links
                if (paymentDetails.status === "approved") {
                    await processApprovedPayment(paymentDetails, supabase);
                }
            }
            res.status(200).json({ received: true });
        }
        catch (error) {
            console.error(`❌ Erro no webhook:`, error);
            res.status(500).json({
                error: "Erro interno",
                details: error instanceof Error ? error.message : "Erro desconhecido"
            });
        }
    });
    // ROTA: GET /api/payments/status/:id - Verificar status do pagamento
    app.get("/api/payments/status/:id", async (req, res) => {
        try {
            const paymentId = req.params.id;
            if (!payment) {
                return res.status(503).json({
                    error: "Serviço de pagamento indisponível",
                    details: "Mercado Pago não configurado"
                });
            }
            const paymentDetails = await retryWithBackoff(() => payment.get({ id: paymentId }), 3, 1000);
            const response = {
                id: paymentDetails.id,
                status: paymentDetails.status,
                status_detail: paymentDetails.status_detail,
                transaction_amount: paymentDetails.transaction_amount
            };
            // Se aprovado, buscar e incluir links de download
            if (paymentDetails.status === "approved") {
                const downloadLinks = await getDownloadLinks(paymentDetails, supabase);
                response.download_links = downloadLinks;
            }
            res.json(response);
        }
        catch (error) {
            console.error(`❌ Erro ao verificar status:`, error);
            res.status(500).json({
                error: "Erro interno",
                details: error instanceof Error ? error.message : "Erro desconhecido"
            });
        }
    });
    // Função para processar pagamento aprovado
    async function processApprovedPayment(paymentDetails, supabase) {
        try {
            console.log(`🎉 Processando pagamento aprovado:`, paymentDetails.id);
            if (!supabase) {
                console.error(`❌ Supabase não configurado`);
                return;
            }
            const metadata = paymentDetails.metadata;
            const carrinho = metadata?.carrinho || [];
            const email = metadata?.email;
            if (!carrinho.length || !email) {
                console.error(`❌ Dados insuficientes no metadata:`, metadata);
                return;
            }
            console.log(`📦 Buscando links de download para ${carrinho.length} produtos`);
            // Buscar download_url para cada produto no carrinho
            const downloadLinks = [];
            for (const item of carrinho) {
                try {
                    const { data: produto, error } = await supabase
                        .from("produtos")
                        .select("id, name, download_url")
                        .eq("id", item.produto_id)
                        .single();
                    if (error || !produto) {
                        console.error(`❌ Erro ao buscar produto ${item.produto_id}:`, error);
                        continue;
                    }
                    if (produto.download_url) {
                        downloadLinks.push({
                            produto_id: produto.id,
                            nome: produto.name,
                            download_url: produto.download_url,
                            quantidade: item.quantidade
                        });
                        console.log(`✅ Link encontrado para produto ${produto.name}`);
                    }
                    else {
                        console.warn(`⚠️ Produto ${produto.name} não possui download_url`);
                    }
                }
                catch (error) {
                    console.error(`❌ Erro ao processar produto ${item.produto_id}:`, error);
                }
            }
            if (downloadLinks.length > 0) {
                console.log(`📧 Enviando ${downloadLinks.length} links para ${email}`);
                // Aqui você pode implementar o envio por email
                // Por agora, apenas logamos os links que seriam enviados
                console.log(`🔗 Links de download para ${email}:`, downloadLinks);
                // TODO: Implementar envio de email com os links
                // await sendDownloadEmail(email, downloadLinks);
            }
            else {
                console.warn(`⚠️ Nenhum link de download encontrado para o pagamento ${paymentDetails.id}`);
            }
        }
        catch (error) {
            console.error(`❌ Erro ao processar pagamento aprovado:`, error);
        }
    }
    // Função para buscar links de download
    async function getDownloadLinks(paymentDetails, supabase) {
        if (!supabase)
            return [];
        try {
            const metadata = paymentDetails.metadata;
            const carrinho = metadata?.carrinho || [];
            const downloadLinks = [];
            for (const item of carrinho) {
                const { data: produto, error } = await supabase
                    .from("produtos")
                    .select("id, name, download_url")
                    .eq("id", item.produto_id)
                    .single();
                if (!error && produto?.download_url) {
                    downloadLinks.push({
                        produto_id: produto.id,
                        nome: produto.name,
                        download_url: produto.download_url
                    });
                }
            }
            return downloadLinks;
        }
        catch (error) {
            console.error(`❌ Erro ao buscar links:`, error);
            return [];
        }
    }
    const httpServer = (0, http_1.createServer)(app);
    return httpServer;
}
