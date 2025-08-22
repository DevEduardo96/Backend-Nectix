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

// Schema de validação para o endereço
const enderecoSchema = zod_1.z.object({
    cep: zod_1.z.string().min(1, "CEP é obrigatório"),
    rua: zod_1.z.string().min(1, "Rua é obrigatória"),
    numero: zod_1.z.string().min(1, "Número é obrigatório"),
    complemento: zod_1.z.string().optional(),
    bairro: zod_1.z.string().min(1, "Bairro é obrigatório"),
    cidade: zod_1.z.string().min(1, "Cidade é obrigatória"),
    estado: zod_1.z.string().min(1, "Estado é obrigatório")
});

// Validação dos dados de entrada para pagamento - ATUALIZADA
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
        quantity: zod_1.z.number().min(1, "Quantidade deve ser maior que zero"),
        variacoes: zod_1.z.object({
            cor: zod_1.z.string().optional(),
            tamanho: zod_1.z.string().optional()
        }).optional()
    })),
    nomeCliente: zod_1.z.string().min(1, "Nome do cliente é obrigatório"),
    email: zod_1.z.string().email("Email inválido"),
    telefone: zod_1.z.string().min(1, "Telefone é obrigatório"), // NOVO CAMPO
    endereco: enderecoSchema, // NOVO CAMPO
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
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
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

    // ROTA: POST /api/payments/criar-pagamento - Para o frontend - ATUALIZADA
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

            const { carrinho, nomeCliente, email, telefone, endereco, total } = validation.data;

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
                    phone: {
                        number: telefone
                    }
                },
                metadata: {
                    carrinho: carrinho.map(item => ({
                        produto_id: item.id,
                        nome: item.name,
                        quantidade: item.quantity,
                        preco_unitario: item.price,
                        variacoes: item.variacoes || {}
                    })),
                    cliente: nomeCliente,
                    email: email,
                    telefone: telefone,
                    endereco: endereco,
                    total_itens: carrinho.length
                }
            };

            console.log(`💳 Criando pagamento PIX:`, {
                amount: total,
                description,
                email,
                cliente: nomeCliente,
                telefone,
                endereco: endereco.cidade + ', ' + endereco.estado,
                items_count: carrinho.length
            });

            const paymentResponse = await retryWithBackoff(() => payment.create({ body: paymentData }), 3, 1000);

            if (!paymentResponse) {
                return res.status(500).json({
                    error: "Erro ao criar pagamento no Mercado Pago"
                });
            }

            console.log(`✅ Pagamento criado no Mercado Pago:`, {
                id: paymentResponse.id,
                status: paymentResponse.status
            });

            // **NOVO: SALVAR PAGAMENTO NO SUPABASE**
            if (supabase) {
                try {
                    console.log(`💾 Salvando pagamento no Supabase...`);
                    
                    const { data: pagamentoData, error: supabaseError } = await supabase
                        .from('pagamentos')
                        .insert([
                            {
                                pagamento_id: paymentResponse.id.toString(),
                                status: paymentResponse.status,
                                email: email,
                                nome_cliente: nomeCliente,
                                telefone: telefone,
                                valor: total,
                                itens: carrinho.map(item => ({
                                    produto_id: item.id,
                                    nome: item.name,
                                    quantidade: item.quantity,
                                    preco_unitario: item.price || 0,
                                    preco_total: (item.price || 0) * item.quantity,
                                    variacoes: item.variacoes || {}
                                })),
                                endereco_entrega: {
                                    cep: endereco.cep,
                                    rua: endereco.rua,
                                    numero: endereco.numero,
                                    complemento: endereco.complemento || null,
                                    bairro: endereco.bairro,
                                    cidade: endereco.cidade,
                                    estado: endereco.estado
                                },
                                created_at: new Date().toISOString(),
                                updated_at: new Date().toISOString()
                            }
                        ])
                        .select();

                    if (supabaseError) {
                        console.error(`❌ Erro ao salvar no Supabase:`, supabaseError);
                        // Não falha a operação, apenas loga o erro
                    } else {
                        console.log(`✅ Pagamento salvo no Supabase:`, pagamentoData?.[0]?.pagamento_id);
                    }
                } catch (supabaseInsertError) {
                    console.error(`❌ Erro inesperado ao salvar no Supabase:`, supabaseInsertError);
                    // Não falha a operação, apenas loga o erro
                }
            } else {
                console.warn(`⚠️ Supabase não configurado - pagamento não foi salvo no banco`);
            }

            // Extrair informações do pagamento para retornar ao frontend
            const paymentInfo = {
                id: paymentResponse.id,
                status: paymentResponse.status,
                qr_code: paymentResponse.point_of_interaction?.transaction_data?.qr_code || null,
                qr_code_base64: paymentResponse.point_of_interaction?.transaction_data?.qr_code_base64 || null,
                ticket_url: paymentResponse.point_of_interaction?.transaction_data?.ticket_url || null,
                total: total,
                cliente: nomeCliente,
                email: email,
                telefone: telefone,
                endereco: endereco,
                produtos: carrinho.map(item => ({
                    id: item.id,
                    nome: item.name,
                    quantidade: item.quantity,
                    variacoes: item.variacoes || {}
                }))
            };

            console.log(`✅ Pagamento processado com sucesso:`, {
                id: paymentInfo.id,
                status: paymentInfo.status,
                qr_code_exists: !!paymentInfo.qr_code,
                saved_to_supabase: !!supabase
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

    // WEBHOOK: POST /api/payments/webhook - Recebe notificações do Mercado Pago - ATUALIZADO
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

                // **NOVO: ATUALIZAR STATUS NO SUPABASE**
                if (supabase) {
                    try {
                        console.log(`💾 Atualizando status no Supabase para pagamento ${paymentId}...`);
                        
                        const { error: updateError } = await supabase
                            .from('pagamentos')
                            .update({ 
                                status: paymentDetails.status,
                                updated_at: new Date().toISOString()
                            })
                            .eq('pagamento_id', paymentId.toString());

                        if (updateError) {
                            console.error(`❌ Erro ao atualizar status no Supabase:`, updateError);
                        } else {
                            console.log(`✅ Status atualizado no Supabase: ${paymentDetails.status}`);
                        }
                    } catch (supabaseUpdateError) {
                        console.error(`❌ Erro inesperado ao atualizar Supabase:`, supabaseUpdateError);
                    }
                }
                
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

    // NOVA ROTA: GET /api/payments/pedido/:id - Buscar dados do pedido no Supabase
    app.get("/api/payments/pedido/:id", async (req, res) => {
        try {
            const paymentId = req.params.id;
            
            if (!supabase) {
                return res.status(503).json({
                    error: "Base de dados indisponível",
                    details: "Supabase não configurado"
                });
            }

            const { data: pedido, error } = await supabase
                .from('pagamentos')
                .select('*')
                .eq('pagamento_id', paymentId)
                .single();

            if (error || !pedido) {
                return res.status(404).json({
                    error: "Pedido não encontrado",
                    details: error?.message || "Pedido não existe"
                });
            }

            res.json({
                id: pedido.pagamento_id,
                status: pedido.status,
                cliente: pedido.nome_cliente,
                email: pedido.email,
                telefone: pedido.telefone,
                valor: pedido.valor,
                itens: pedido.itens,
                endereco_entrega: pedido.endereco_entrega,
                created_at: pedido.created_at,
                updated_at: pedido.updated_at
            });
        }
        catch (error) {
            console.error(`❌ Erro ao buscar pedido:`, error);
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
                            quantidade: item.quantidade,
                            variacoes: item.variacoes || {}
                        });
                        
                        console.log(`✅ Link encontrado para produto ${produto.name}`);
                    } else {
                        console.warn(`⚠️ Produto ${produto.name} não possui download_url`);
                    }
                } catch (error) {
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
                
                // **NOVO: ATUALIZAR STATUS PARA "ENTREGUE" NO SUPABASE**
                try {
                    const { error: deliveryUpdateError } = await supabase
                        .from('pagamentos')
                        .update({ 
                            status: 'delivered', // Status customizado para produtos digitais
                            updated_at: new Date().toISOString()
                        })
                        .eq('pagamento_id', paymentDetails.id.toString());

                    if (deliveryUpdateError) {
                        console.error(`❌ Erro ao marcar como entregue:`, deliveryUpdateError);
                    } else {
                        console.log(`✅ Pagamento marcado como entregue no Supabase`);
                    }
                } catch (error) {
                    console.error(`❌ Erro ao atualizar status de entrega:`, error);
                }
            } else {
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
                        download_url: produto.download_url,
                        variacoes: item.variacoes || {}
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
