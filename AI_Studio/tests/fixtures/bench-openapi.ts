/**
 * The bench apps' API documents (examples/bench-*\/server.mjs OPENAPI) as the bench extension (Phase 4 T2) makes them: the same paths,
 * plus response schemas and the bench-rbac sign-up body. Only the paths the documented-case tests use. Values come from the documents
 * and the requirements, never from a run.
 */
const json = (schema: object) => ({ content: { "application/json": { schema } } });
const error = json({ type: "object", required: ["error"], properties: { error: { type: "string" } } });
const product = { type: "object", required: ["id", "name", "price"], properties: { id: { type: "string" }, name: { type: "string" }, price: { type: "integer" } } };
const order = { type: "object", required: ["id", "status", "total"], properties: { id: { type: "string" }, status: { type: "string" }, total: { type: "integer" } } };
const registerBody = { type: "object", required: ["name", "email", "password"], properties: { name: { type: "string", minLength: 1 }, email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } };
const register = { post: { summary: "Create an account", requestBody: json(registerBody), responses: { 201: { description: "Created and signed in" }, 400: { description: "Invalid input", ...error }, 409: { description: "Email already used" } } } };

export const SHOP_OPENAPI = {
    openapi: "3.0.3",
    info: { title: "BenchShop API", version: "1.0.0" },
    paths: {
        "/api/products": { get: { summary: "List products", responses: { 200: { description: "Products", ...json({ type: "object", properties: { products: { type: "array", items: product } } }) } } } },
        "/api/products/{id}": { get: { summary: "One product", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "The product" }, 404: { description: "No such product" } } } },
        "/api/register": register,
        "/api/login": { post: { summary: "Sign in", responses: { 200: { description: "Signed in" }, 401: { description: "Wrong email or password" } } } },
        "/api/cart": { get: { summary: "Your cart", responses: { 200: { description: "Cart" }, 401: { description: "Not signed in" } } } },
        "/api/cart/items": { post: { summary: "Add a product (quantity 1-10 per item)", requestBody: json({ type: "object", required: ["productId"], properties: { productId: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 10 } } }), responses: { 201: { description: "Added" }, 400: { description: "Invalid quantity" }, 404: { description: "No such product" } } } },
        "/api/orders": { get: { summary: "Your orders, newest first", responses: { 200: { description: "Orders", ...json({ type: "object", properties: { orders: { type: "array", items: order } } }) } } }, post: { summary: "Place an order from the cart", responses: { 201: { description: "Order placed" }, 409: { description: "Cart empty or no address" } } } },
        "/api/orders/{id}": { get: { summary: "One of your orders", responses: { 200: { description: "Order", ...json(order) }, 404: { description: "Not found or not yours" } } } },
    },
};

export const RBAC_OPENAPI = {
    openapi: "3.0.3",
    info: { title: "BenchNotes API", version: "1.0.0" },
    paths: {
        "/api/register": register,
        "/api/notes": { get: { summary: "Notes you may read", responses: { 200: { description: "Notes" } } }, post: { summary: "Create a note (title required, at most 120 characters)", requestBody: json({ type: "object", required: ["title"], properties: { title: { type: "string", minLength: 1, maxLength: 120 }, body: { type: "string" } } }), responses: { 201: { description: "Created" }, 400: { description: "Missing title" } } } },
    },
};
