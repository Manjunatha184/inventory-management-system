import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import { WorkspaceClient } from "@databricks/databricks-sdk";

dotenv.config();

const app = express();
const port = process.env.PORT || 8000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// DATABRICKS CONFIGURATION
// ============================================

const DATABRICKS_HOST = process.env.DATABRICKS_HOST;

const client = new WorkspaceClient({
  host: process.env.DATABRICKS_HOST.startsWith("http")
    ? process.env.DATABRICKS_HOST
    : "https://" + process.env.DATABRICKS_HOST,
  token: process.env.DATABRICKS_TOKEN
});

async function getSecrets() {
  const token = await client.secrets.getSecret({
    scope: "inventory-scope",
    key: "DATABRICKS_TOKEN"
  });

  const warehouse = await client.secrets.getSecret({
    scope: "inventory-scope",
    key: "DATABRICKS_WAREHOUSE_ID"
  });

  return {
    TOKEN: Buffer.from(token.value, "base64").toString(),
    WAREHOUSE_ID: Buffer.from(warehouse.value, "base64").toString()
  };
}

console.log('🔷 Databricks Config:', {
  host: DATABRICKS_HOST ? '✅ Set' : '❌ Missing',
  token: TOKEN ? '✅ Set' : '❌ Missing',
  warehouse: WAREHOUSE_ID ? '✅ Set' : '❌ Missing'
});

// ============================================
// LOGGING UTILITY
// ============================================

function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = JSON.stringify({
    timestamp,
    level,
    message,
    data,
    environment: process.env.NODE_ENV || 'development'
  });
  console.log(logEntry);
}

// ============================================
// EXECUTE SQL QUERY
// ============================================

async function executeSQL(statement) {
  try {
    const secrets = await getSecrets();

    console.log("QUERY SENT:", statement);

    let response = await axios.post(
      `${DATABRICKS_HOST}/api/2.0/sql/statements`,
      {
        statement,
        warehouse_id: secrets.WAREHOUSE_ID
      },
      {
        headers: {
          Authorization: `Bearer ${secrets.TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    let statementId = response.data.statement_id;

    while (
      response.data.status.state === "PENDING" ||
      response.data.status.state === "RUNNING"
    ) {
      await new Promise((res) => setTimeout(res, 500));

      response = await axios.get(
        `${DATABRICKS_HOST}/api/2.0/sql/statements/${statementId}`,
        {
          headers: {
            Authorization: `Bearer ${secrets.TOKEN}`,
            "Content-Type": "application/json"
          }
        }
      );
    }

    return response.data;
  } catch (error) {
    console.error("SQL ERROR:", error.message);
    throw error;
  }
}

// ============================================
// EXTRACT DATA FROM RESPONSE
// ============================================

function extractData(result) {
  try {
    if (!result || !result.manifest || !result.result || !result.result.data_array) {
      return [];
    }

    const columns = result.manifest.schema.columns.map((c) => c.name);
    return result.result.data_array.map((row) => {
      const obj = {};
      row.forEach((val, i) => {
        obj[columns[i]] = val;
      });
      return obj;
    });
  } catch (error) {
    log('ERROR', 'Data extraction failed', { error: error.message });
    return [];
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================

let sessions = {};
const loginLocks = new Set();

function verifyToken(req, res, next) {
  const sessionId = req.headers['x-session-id'];

  if (!sessionId || !sessions[sessionId]) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.user = sessions[sessionId];
  next();
}

// ============================================
// AUTHENTICATION ROUTES
// ============================================

app.post('/api/auth/admin-login', (req, res) => {
  try {
    const { email, password } = req.body;

    // Demo admin credentials
    if (email === 'admin@company.com' && password === 'admin123') {
      const sessionId = Math.random().toString(36).substring(7);
      sessions[sessionId] = { role: 'admin', email, userId: 1 };

      log('INFO', 'Admin login successful', { email });
      return res.json({
        status: 'success',
        sessionId,
        user: { name: 'Admin User', email }
      });
    }

    log('WARN', 'Admin login failed', { email, reason: 'Invalid credentials' });
    res.status(401).json({ status: 'error', message: 'Invalid credentials' });
  } catch (error) {
    log('ERROR', 'Admin login error', { error: error.message });
    res.status(500).json({ status: 'error', message: 'Login failed' });
  }
});

app.post('/api/auth/employee-login', async (req, res) => {
  const { email, password } = req.body;

  if (loginLocks.has(email)) {
    return res.status(429).json({
      status: 'error',
      message: 'Login in progress. Please wait.'
    });
  }

  loginLocks.add(email);

  try {
    const escapedEmail = email.replace(/'/g, "''");
    const escapedPassword = password.replace(/'/g, "''");

    const result = await executeSQL(
      `SELECT id, email, name, department FROM employees WHERE email='${escapedEmail}' AND password='${escapedPassword}' AND is_active = true LIMIT 1`
    );

    const rows = extractData(result);

    if (rows.length > 0) {
      const employee = rows[0];
      const sessionId = Math.random().toString(36).substring(7);

      sessions[sessionId] = {
        role: 'employee',
        email: employee.email,
        userId: employee.id,
        userName: employee.name
      };

      log('INFO', 'Employee login successful', { email, employeeId: employee.id });
      return res.json({
        status: 'success',
        sessionId,
        user: {
          id: employee.id,
          name: employee.name,
          email: employee.email,
          department: employee.department
        }
      });
    }

    log('WARN', 'Employee login failed', { email, reason: 'Invalid credentials' });
    res.status(401).json({ status: 'error', message: 'Invalid credentials' });
  } catch (err) {
    log('ERROR', 'Employee login database error', { email, error: err.message });
    res.status(500).json({ status: 'error', message: 'Login failed' });
  } finally {
    loginLocks.delete(email);
  }
});

app.post('/api/auth/logout', (req, res) => {
  const { sessionId } = req.body;
  if (sessions[sessionId]) {
    log('INFO', 'User logout', { email: sessions[sessionId].email });
    delete sessions[sessionId];
  }
  res.json({ status: 'success' });
});

// ============================================
// EMPLOYEE MANAGEMENT
// ============================================

app.get('/api/admin/employees', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await executeSQL(`
      SELECT id, email, name, department 
      FROM employees
      WHERE is_active = true
    `);
    console.log("FETCH EMPLOYEES QUERY RUNNING...");

    res.json({ status: 'success', data: extractData(result) });
  } catch (err) {
    log('ERROR', 'Get employees failed', { error: err.message });
    res.status(500).json({ status: 'error', message: 'Database error' });
    console.error("ERROR:", err.message);
  }
});

app.post('/api/admin/employees', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { email, password, name, department, phone } = req.body;

    if (!email || !password || !name || !department) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const escapedEmail = email.replace(/'/g, "''");
    const escapedPassword = password.replace(/'/g, "''");
    const escapedName = name.replace(/'/g, "''");
    const escapedDept = department.replace(/'/g, "''");
    const escapedPhone = (phone || '').replace(/'/g, "''");

    const existCheck = await executeSQL(`SELECT id FROM employees WHERE email = '${escapedEmail}'`);
    if (extractData(existCheck).length > 0) {
      return res.status(400).json({ status: 'error', message: 'Email already exists' });
    }

    const id = Date.now(); // ✅ generate id

    const query = `
  INSERT INTO employees (
  id, email, password, name, department, is_active
)
VALUES (
  '${id}',
  '${escapedEmail}',
  '${escapedPassword}',
  '${escapedName}',
  '${escapedDept}',
  true
)
`;

    console.log("EMP INSERT QUERY:", query); // 🔥 debug

    await executeSQL(query);

    res.json({ status: 'success', message: 'Employee created' });

  } catch (err) {
    console.error("EMP INSERT ERROR:", err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: 'Database error' });
  }
});

app.delete('/api/admin/employees/:id', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await executeSQL(`
      UPDATE employees 
      SET is_active = false 
      WHERE id = '${req.params.id}'
    `);

    log('INFO', 'Employee deleted', {
      employeeId: req.params.id,
      deletedBy: req.user.email
    });
    res.json({ status: 'success' });
  } catch (err) {
    log('ERROR', 'Employee deletion failed', { error: err.message });
    res.status(500).json({ status: 'error', message: 'Database error' });
  }
});

// ============================================
// INVENTORY MANAGEMENT
// ============================================

app.get('/api/admin/inventory', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await executeSQL(
      'SELECT id, name, category, quantity, unit_price as price, total_value, condition, location, reorder_point, min_quantity, max_quantity, created_at FROM items WHERE is_active = true ORDER BY category, name'
    );

    res.json({ status: 'success', data: extractData(result) });
  } catch (err) {
    log('ERROR', 'Get inventory failed', { error: err.message });
    res.status(500).json({ status: 'error', message: 'Database error' });
  }
});

app.post('/api/admin/inventory', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { name, category, quantity, condition, location, reorder_point } = req.body;
    const unit_price = req.body.unit_price || req.body.price;

    if (!name || !category || quantity === undefined || !unit_price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const escapedName = name.replace(/'/g, "''");
    const escapedCategory = category.replace(/'/g, "''");
    const escapedCondition = (condition || 'Good').replace(/'/g, "''");
    const escapedLocation = (location || '').replace(/'/g, "''");

    const query = `
      INSERT INTO items (
  id, name, category, quantity, unit_price, condition, location,
  reorder_point, min_quantity, max_quantity, is_active, created_at
)
VALUES (
  '${Date.now()}',
  '${escapedName}',
  '${escapedCategory}',
  ${quantity},
  ${unit_price},
  '${escapedCondition}',
  '${escapedLocation}',
  ${reorder_point || 10},
  5,
  100,
  true,
  CURRENT_TIMESTAMP
)
    `;

    await executeSQL(query);

    log('INFO', 'Inventory item created', {
      name,
      category,
      quantity,
      createdBy: req.user.email
    });
    res.json({ status: 'success', message: 'Item added' });
  } catch (err) {
    log('ERROR', 'Item creation failed', { error: err.message });
    res.status(500).json({ status: 'error', message: 'Database error' });
  }
});



app.delete('/api/admin/inventory/:id', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await executeSQL(`UPDATE items SET is_active = false WHERE id = '${req.params.id}'`);

    log('INFO', 'Inventory item deleted', {
      itemId: req.params.id,
      deletedBy: req.user.email
    });
    res.json({ status: 'success' });
  } catch (err) {
    log('ERROR', 'Item deletion failed', { error: err.message });
    res.status(500).json({ status: 'error', message: 'Database error' });
  }
});

// ============================================
// FEATURE 1: LOW STOCK ALERTS
// ============================================

async function checkLowStock() {
  try {
    const result = await executeSQL(`
      SELECT id, name, quantity, min_quantity, reorder_point
      FROM items
      WHERE quantity <= min_quantity AND is_active = true
    `);

    const lowStockItems = extractData(result);

    for (const item of lowStockItems) {
      const existingAlert = await executeSQL(`
        SELECT * FROM stock_alerts
        WHERE item_id = ${item.id} AND alert_status = 'active'
      `);

      if (extractData(existingAlert).length === 0) {
        await executeSQL(`
          INSERT INTO stock_alerts (item_id, alert_type, current_quantity, min_quantity)
          VALUES (${item.id}, 'LOW_STOCK', ${item.quantity}, ${item.min_quantity})
        `);

        log('ALERT', 'Low stock detected', {
          itemId: item.id,
          itemName: item.name,
          quantity: item.quantity
        });
      }
    }
  } catch (error) {
    log('ERROR', 'Low stock check failed', { error: error.message });
  }
}

// Run low stock check every hour
setInterval(checkLowStock, 60 * 60 * 1000);

app.get('/api/admin/alerts', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await executeSQL(`
      SELECT 
        a.id,
        a.alert_type,
        i.name,
        i.category,
        a.current_quantity,
        a.min_quantity,
        a.created_at,
        (a.min_quantity - a.current_quantity) as quantity_short
      FROM stock_alerts a
      JOIN items i ON a.item_id = i.id
      WHERE a.alert_status = 'active'
      ORDER BY a.created_at DESC
    `);

    res.json({ status: 'success', data: extractData(result) });
  } catch (error) {
    log('ERROR', 'Get alerts failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/alerts/:id/resolve', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await executeSQL(`
      UPDATE stock_alerts
      SET alert_status = 'resolved', resolved_at = CURRENT_TIMESTAMP
      WHERE id = '${req.params.id}'
    `);

    log('INFO', 'Alert resolved', { alertId: req.params.id, resolvedBy: req.user.email });
    res.json({ status: 'success' });
  } catch (error) {
    log('ERROR', 'Alert resolution failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FEATURE 2: INVENTORY TRANSACTIONS
// ============================================

async function logTransaction(itemId, type, quantity, reason, performedBy, notes) {
  try {
    const escapedReason = reason.replace(/'/g, "''");
    const escapedNotes = (notes || '').replace(/'/g, "''");
    const escapedBy = performedBy.replace(/'/g, "''");

    await executeSQL(`
      INSERT INTO transactions
      (id, item_id, transaction_type, quantity_change, reason, performed_by, notes)
      VALUES (
        '${Date.now()}',
        '${itemId}',
        '${type}',
        ${quantity},
        '${escapedReason}',
        '${escapedBy}',
        '${escapedNotes}'
      )
    `);
  } catch (error) {
    log('ERROR', 'Transaction log failed', { error: error.message });
  }
}

app.get('/api/admin/inventory/:id/history', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await executeSQL(`
      SELECT 
        transaction_type,
        quantity_change,
        reason,
        performed_by,
        notes,
        transaction_date
      FROM transactions
      WHERE item_id = '${req.params.id}'
      ORDER BY transaction_date DESC
      LIMIT 50
    `);

    res.json({ status: 'success', data: extractData(result) });
  } catch (error) {
    log('ERROR', 'Get history failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FEATURE 3: ADD STOCK
// ============================================

app.post('/api/admin/inventory/:id/add-stock', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const itemId = req.params.id;
    const { quantity, reason, notes } = req.body;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    const itemResult = await executeSQL(`SELECT * FROM items WHERE id = '${itemId}'`);
    const items = extractData(itemResult);

    if (items.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = items[0];
    const newQuantity = item.quantity + quantity;

    if (newQuantity > item.max_quantity) {
      return res.status(400).json({
        error: 'Exceeds maximum quantity',
        current: item.quantity,
        max: item.max_quantity,
        attempting: newQuantity
      });
    }

    await executeSQL(`
      UPDATE items
      SET quantity = ${newQuantity}, updated_at = CURRENT_TIMESTAMP
      WHERE id = '${itemId}'
    `);

    await logTransaction(itemId, 'STOCK_ADDITION', quantity, reason, req.user.email, notes);

    if (newQuantity > item.min_quantity) {
      await executeSQL(`
        UPDATE stock_alerts
        SET alert_status = 'resolved', resolved_at = CURRENT_TIMESTAMP
        WHERE item_id = '${itemId}' AND alert_status = 'active'
      `);
    }

    log('INFO', 'Stock added', { itemId, quantity, reason, addedBy: req.user.email });
    res.json({
      status: 'success',
      message: `Added ${quantity} units`,
      newQuantity,
      item: item.name
    });
  } catch (error) {
    log('ERROR', 'Add stock failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FEATURE 4: REMOVE STOCK
// ============================================

app.post('/api/admin/inventory/:id/remove-stock', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const itemId = req.params.id;
    const { quantity, reason, notes } = req.body;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    const itemResult = await executeSQL(`SELECT * FROM items WHERE id = '${itemId}'`);
    const items = extractData(itemResult);

    if (items.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = items[0];

    if (item.quantity < quantity) {
      return res.status(400).json({
        error: 'Cannot remove more than available',
        available: item.quantity,
        attempting: quantity
      });
    }

    const newQuantity = item.quantity - quantity;

    await executeSQL(`
      UPDATE items
      SET quantity = ${newQuantity}, updated_at = CURRENT_TIMESTAMP
      WHERE id = '${itemId}'
    `);

    await logTransaction(itemId, 'STOCK_REMOVAL', -quantity, reason, req.user.email, notes);

    if (newQuantity <= item.min_quantity) {
      const alertResult = await executeSQL(`
        SELECT * FROM stock_alerts
        WHERE item_id = '${itemId}' AND alert_status = 'active'
      `);

      if (extractData(alertResult).length === 0) {
        await executeSQL(`
          INSERT INTO stock_alerts
          (id, item_id, alert_type, current_quantity, min_quantity)
          VALUES ('${Date.now()}', '${itemId}', 'LOW_STOCK', ${newQuantity}, ${item.min_quantity})
        `);
      }
    }

    log('INFO', 'Stock removed', { itemId, quantity, reason, removedBy: req.user.email });
    res.json({
      status: 'success',
      message: `Removed ${quantity} units`,
      newQuantity,
      item: item.name
    });
  } catch (error) {
    log('ERROR', 'Remove stock failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FEATURE 5: INVENTORY SUMMARY & REPORTS
// ============================================

app.get('/api/admin/inventory-summary', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const totalValueResult = await executeSQL(`
      SELECT COALESCE(SUM(total_value), 0) as total FROM items WHERE is_active = true
    `);
    const totalValue = extractData(totalValueResult)[0]?.total || 0;

    const categoryResult = await executeSQL(`
      SELECT 
        category,
        COUNT(*) as item_count,
        SUM(quantity) as total_quantity,
        COALESCE(SUM(total_value), 0) as category_value
      FROM items
      WHERE is_active = true
      GROUP BY category
      ORDER BY category_value DESC
    `);

    const lowStockResult = await executeSQL(`
      SELECT COUNT(*) as count FROM items
      WHERE quantity < min_quantity AND is_active = true
    `);
    const lowStockCount = extractData(lowStockResult)[0]?.count || 0;

    const overstockResult = await executeSQL(`
      SELECT COUNT(*) as count FROM items
      WHERE quantity > max_quantity AND is_active = true
    `);
    const overstockCount = extractData(overstockResult)[0]?.count || 0;

    const pendingResult = await executeSQL(`
      SELECT COUNT(*) as count FROM requests
      WHERE status = 'pending'
    `);
    const pendingRequests = extractData(pendingResult)[0]?.count || 0;

    const totalItemsResult = await executeSQL(`
      SELECT COUNT(*) as count FROM items WHERE is_active = true
    `);
    const totalItems = extractData(totalItemsResult)[0]?.count || 0;

    res.json({
      status: 'success',
      data: {
        totalValue,
        totalItems,
        byCategory: extractData(categoryResult),
        lowStockCount,
        overstockCount,
        pendingRequests
      }
    });
  } catch (error) {
    log('ERROR', 'Get inventory summary failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FEATURE 6: REQUESTS
// ============================================

app.get('/api/admin/requests', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await executeSQL(`
      SELECT 
        r.id,
        e.name as employeeName,
        e.department,
        i.name as itemName,
        i.quantity as available_quantity,
        r.quantity_requested as quantity,
        CASE 
          WHEN i.quantity = 0 THEN 'OUT_OF_STOCK'
          WHEN i.quantity < r.quantity_requested THEN 'PARTIAL'
          ELSE 'FULL'
        END as fulfillment_status,
        r.reason,
        r.status,
        r.requested_date as date
      FROM requests r
      JOIN employees e ON r.employee_id = e.id
      JOIN items i ON r.item_id = i.id
      WHERE r.status != 'rejected'
      ORDER BY r.requested_date ASC
    `);

    const data = extractData(result).map(item => ({
      ...item,
      date: item.date
        ? new Date(item.date).toLocaleString()
        : '-'
    }));

    res.json({ status: 'success', data });
  } catch (error) {
    log('ERROR', 'Get requests failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/requests/pending', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await executeSQL(`
      SELECT 
        r.id,
        e.name as employeeName,
        e.department,
        i.name as itemName,
        i.quantity as available_quantity,
        r.quantity_requested as quantity,
        CASE 
          WHEN i.quantity = 0 THEN 'OUT_OF_STOCK'
          WHEN i.quantity < r.quantity_requested THEN 'PARTIAL'
          ELSE 'FULL'
        END as fulfillment_status,
        r.reason,
        'pending' as status,
        r.requested_date as date
      FROM requests r
      JOIN employees e ON r.employee_id = e.id
      JOIN items i ON r.item_id = i.id
      WHERE r.status = 'pending'
      ORDER BY r.requested_date ASC
    `);

    res.json({ status: 'success', data: extractData(result) });
  } catch (error) {
    log('ERROR', 'Get pending requests failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/employee/requests', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { itemId, quantity, reason } = req.body;

    if (!itemId || !quantity || quantity <= 0) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const escapedReason = (reason || '').replace(/'/g, "''");

    const itemResult = await executeSQL(`SELECT quantity FROM items WHERE id = '${itemId}'`);
    const items = extractData(itemResult);
    if (items.length === 0 || items[0].quantity < quantity) {
      return res.status(400).json({ error: 'Insufficient available stock to place request' });
    }

    await executeSQL(`
      UPDATE items
      SET quantity = quantity - ${quantity}, updated_at = CURRENT_TIMESTAMP
      WHERE id = '${itemId}'
    `);

    await executeSQL(`
      INSERT INTO requests (
        id,
        employee_id,
        item_id,
        quantity_requested,
        quantity_approved,
        status,
        reason,
        requested_date
      )
      VALUES (
        '${Date.now()}',
        '${req.user.userId}',
        '${itemId}',
        ${quantity},
        NULL,
        'pending',
        '${escapedReason}',
        CURRENT_TIMESTAMP
      )
    `);

    log('INFO', 'Request created', {
      employeeId: req.user.userId,
      itemId,
      quantity
    });
    res.json({ status: 'success', message: 'Request submitted' });
  } catch (error) {
    log('ERROR', 'Request creation failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/employee/requests', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await executeSQL(`
      SELECT 
        r.id,
        i.name as itemName,
        r.quantity_requested as quantity,
        r.quantity_approved,
        r.status,
        r.requested_date as date,
        r.reason
      FROM requests r
      JOIN items i ON r.item_id = i.id
      WHERE r.employee_id = '${req.user.userId}'
      ORDER BY r.requested_date DESC
    `);

    const data = extractData(result).map(item => ({
      ...item,
      date: item.date
        ? new Date(item.date).toLocaleString()
        : '-'
    }));

    res.json({ status: 'success', data });
  } catch (error) {
    log('ERROR', 'Get employee requests failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/requests/:id/approve', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const requestId = req.params.id;

    const requestResult = await executeSQL(
      `SELECT * FROM requests WHERE id = '${requestId}'`
    );
    const requests = extractData(requestResult);

    if (requests.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const request = requests[0];
    const approvedQuantity = req.body.approvedQuantity || request.quantity_requested;
    const notes = req.body.notes || '';

    if (!approvedQuantity || approvedQuantity <= 0 || approvedQuantity > request.quantity_requested) {
      return res.status(400).json({ error: 'Invalid approval quantity' });
    }

    const itemResult = await executeSQL(
      `SELECT * FROM items WHERE id = '${request.item_id}'`
    );
    const items = extractData(itemResult);
    const item = items[0];

    if (item.quantity < approvedQuantity) {
      return res.status(400).json({ error: 'Insufficient stock' });
    }

    await executeSQL(`
      UPDATE requests
      SET status = 'approved',
          quantity_approved = ${approvedQuantity},
          approved_date = CURRENT_TIMESTAMP,
          approved_by = '${req.user.email}'
      WHERE id = '${requestId}'
    `);

    const refundQuantity = request.quantity_requested - approvedQuantity;
    if (refundQuantity > 0) {
      await executeSQL(`
        UPDATE items
        SET quantity = quantity + ${refundQuantity}, updated_at = CURRENT_TIMESTAMP
        WHERE id = '${request.item_id}'
      `);
    }

    await logTransaction(
      request.item_id,
      'REQUEST_APPROVAL',
      -approvedQuantity,
      `Request approval (requested: ${request.quantity_requested}, approved: ${approvedQuantity})`,
      req.user.email,
      notes
    );

    log('INFO', 'Request approved', {
      requestId,
      approvedQuantity,
      approvedBy: req.user.email
    });
    res.json({
      status: 'success',
      message:
        approvedQuantity === request.quantity_requested
          ? 'Fully approved'
          : `Partially approved: ${approvedQuantity} of ${request.quantity_requested}`
    });
  } catch (error) {
    log('ERROR', 'Request approval failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/requests/:id/reject', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { rejectionReason } = req.body;
    const escapedReason = (rejectionReason || '').replace(/'/g, "''");

    const requestResult = await executeSQL(
      `SELECT item_id, quantity_requested FROM requests WHERE id = '${req.params.id}'`
    );
    const reqData = extractData(requestResult)[0];

    if (reqData) {
      await executeSQL(`
        UPDATE items
        SET quantity = quantity + ${reqData.quantity_requested}, updated_at = CURRENT_TIMESTAMP
        WHERE id = '${reqData.item_id}'
      `);
    }

    await executeSQL(`
      UPDATE requests
      SET status = 'rejected',
          rejected_date = CURRENT_TIMESTAMP,
          rejection_reason = '${escapedReason}'
      WHERE id = '${req.params.id}'
    `);

    log('INFO', 'Request rejected', {
      requestId: req.params.id,
      rejectedBy: req.user.email
    });
    res.json({ status: 'success', message: 'Request rejected' });
  } catch (error) {
    log('ERROR', 'Request rejection failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FEATURE 7: SEARCH & FILTER
// ============================================

app.get('/api/inventory/search', verifyToken, async (req, res) => {
  try {
    const { query, category } = req.query;

    let sql = `SELECT * FROM items WHERE is_active = true`;

    if (query) {
      const escapedQuery = query.replace(/'/g, "''");
      sql += ` AND (name LIKE '%${escapedQuery}%' OR category LIKE '%${escapedQuery}%')`;
    }

    if (category) {
      const escapedCategory = category.replace(/'/g, "''");
      sql += ` AND category = '${escapedCategory}'`;
    }

    sql += ` ORDER BY name`;

    const result = await executeSQL(sql);
    res.json({ status: 'success', data: extractData(result) });
  } catch (error) {
    log('ERROR', 'Search failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/inventory/categories', verifyToken, async (req, res) => {
  try {
    const result = await executeSQL(`
      SELECT DISTINCT category FROM items
      WHERE is_active = true
      ORDER BY category
    `);

    const categories = extractData(result).map((c) => c.category);
    res.json({ status: 'success', data: categories });
  } catch (error) {
    log('ERROR', 'Get categories failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// EMPLOYEE DASHBOARD
// ============================================

app.get('/api/employee/dashboard', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'employee') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const userId = req.user.userId;

    const requestsResult = await executeSQL(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
      FROM requests
      WHERE employee_id = ${userId}
    `);

    const requestsSummary = extractData(requestsResult)[0];

    const itemsResult = await executeSQL(`
      SELECT id, name, category, quantity, unit_price
      FROM items
      WHERE quantity > 0 AND is_active = true
      ORDER BY category, name
    `);

    const recentResult = await executeSQL(`
      SELECT 
        r.id,
        i.name as item_name,
        r.quantity_requested,
        r.quantity_approved,
        r.status,
        r.requested_date
      FROM requests r
      JOIN items i ON r.item_id = i.id
      WHERE r.employee_id = ${userId}
      ORDER BY r.requested_date DESC
      LIMIT 5
    `);

    res.json({
      status: 'success',
      data: {
        requests: requestsSummary,
        availableItems: extractData(itemsResult),
        recentRequests: extractData(recentResult)
      }
    });
  } catch (error) {
    log('ERROR', 'Get employee dashboard failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STATS
// ============================================

app.get('/api/stats', verifyToken, async (req, res) => {
  try {
    const empResult = await executeSQL(
      'SELECT COUNT(*) as count FROM employees WHERE is_active = true'
    );
    const invResult = await executeSQL(
      'SELECT COUNT(*) as count FROM items WHERE is_active = true'
    );
    const totalValueResult = await executeSQL(
      'SELECT COALESCE(SUM(total_value), 0) as total FROM items WHERE is_active = true'
    );
    const pendingResult = await executeSQL(
      "SELECT COUNT(*) as count FROM requests WHERE status = 'pending'"
    );

    const empCount = extractData(empResult)[0]?.count || 0;
    const invCount = extractData(invResult)[0]?.count || 0;
    const totalValue = extractData(totalValueResult)[0]?.total || 0;
    const pendingRequests = extractData(pendingResult)[0]?.count || 0;

    res.json({
      status: 'success',
      data: {
        totalEmployees: empCount,
        totalItems: invCount,
        totalValue,
        pendingRequests
      }
    });
  } catch (err) {
    log('ERROR', 'Get stats failed', { error: err.message });
    res.status(500).json({ status: 'error', message: 'Database error' });
  }
});

// ============================================
// FRONTEND ROUTES
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/admin-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin-dashboard.html'));
});

app.get('/admin-employees', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin-employees.html'));
});

app.get('/admin-inventory', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin-inventory.html'));
});

app.get('/admin-requests', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin-requests.html'));
});

app.get('/employee-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/employee-dashboard.html'));
});

app.get('/employee-inventory', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/employee-inventory.html'));
});

app.get('/employee-requests', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/employee-requests.html'));
});

app.get('/employee-owned', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/employee-owned.html'));
});

app.get('/test-db', async (req, res) => {
  try {
    const result = await executeSQL(`SELECT 1 as test`);
    res.json({ success: true, data: extractData(result) });
  } catch (err) {
    console.error("DB TEST ERROR:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
// ============================================
// EMPLOYEE MISSING ROUTES & NEW FEATURES
// ============================================

app.post('/api/employee/my-items/:id/return', verifyToken, async (req, res) => {
  try {
    const requestId = req.params.id;

    // Log the transaction securely using Databricks
    const requestResult = await executeSQL(`
      SELECT item_id, quantity_approved 
      FROM requests 
      WHERE id = '${requestId}' AND employee_id = '${req.user.userId}' AND status = 'approved'
    `);
    const reqData = extractData(requestResult)[0];

    if (!reqData) {
      return res.status(404).json({ error: 'Item not found or already returned' });
    }

    // Update inventory to add the returned item back to available stock
    await executeSQL(`
      UPDATE items
      SET quantity = quantity + ${reqData.quantity_approved}, updated_at = CURRENT_TIMESTAMP
      WHERE id = '${reqData.item_id}'
    `);

    // Mark the request as returned
    await executeSQL(`
      UPDATE requests
      SET status = 'returned', rejected_date = CURRENT_TIMESTAMP, rejection_reason = 'Employee gracefully returned item'
      WHERE id = '${requestId}'
    `);

    // Create a transaction audit log for the company
    await logTransaction(
      reqData.item_id,
      'COMPANY_RETURN',
      reqData.quantity_approved,
      'Employee returned assigned item',
      req.user.email,
      'Auto-logged return via employee portal'
    );

    res.json({ status: 'success', message: 'Item successfully returned to company stock' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Return processing failed' });
  }
});

app.get('/api/employee/inventory', verifyToken, async (req, res) => {
  try {
    const result = await executeSQL(
      'SELECT id, name, category, quantity, unit_price as price, total_value, condition, location, reorder_point, min_quantity, max_quantity, created_at FROM items WHERE is_active = true ORDER BY name'
    );
    res.json({ status: 'success', data: extractData(result) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Database error' });
  }
});

app.get('/api/employee/my-items', verifyToken, async (req, res) => {
  try {
    const result = await executeSQL(`
      SELECT 
        i.name as itemName,
        r.id as serialNumber,
        r.approved_date as assignedDate
      FROM requests r
      JOIN items i ON r.item_id = i.id
      WHERE r.employee_id = '${req.user.userId}' AND r.status = 'approved'
      ORDER BY r.approved_date DESC
    `);
    const formattedData = extractData(result).map(item => ({
      ...item,
      assignedDate: item.assignedDate ? new Date(item.assignedDate).toLocaleDateString() : '-'
    }));
    res.json({ status: 'success', data: formattedData });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Database error' });
  }
});

app.get('/api/admin/employees/:id/items', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const result = await executeSQL(`
      SELECT 
        i.name as itemName,
        r.id as serialNumber,
        r.approved_date as assignedDate
      FROM requests r
      JOIN items i ON r.item_id = i.id
      WHERE r.employee_id = '${req.params.id}' AND r.status = 'approved'
      ORDER BY r.approved_date DESC
    `);
    const formattedData = extractData(result).map(item => ({
      ...item,
      assignedDate: item.assignedDate ? new Date(item.assignedDate).toLocaleDateString() : '-'
    }));
    res.json({ status: 'success', data: formattedData });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Database error' });
  }
});

// ============================================
// SERVER START
// ============================================

const server = app.listen(port, () => {
  log('INFO', 'Server started', { port, environment: process.env.NODE_ENV || 'development' });
  console.log(`\n✅ Server running at http://localhost:${port}\n`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('INFO', 'SIGTERM signal received: closing HTTP server');
  server.close(() => {
    log('INFO', 'HTTP server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  log('ERROR', 'Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});


export default app;