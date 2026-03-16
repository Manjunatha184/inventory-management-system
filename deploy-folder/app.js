import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const port = process.env.PORT || 8000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// IN-MEMORY DATABASE
// ============================================

let admins = [
  { id: 1, email: 'admin@company.com', password: 'admin123', name: 'Admin User', role: 'admin' }
];

let employees = [
  { id: 1, email: 'employee1@company.com', password: 'emp123', name: 'John Doe', role: 'employee', department: 'IT' },
  { id: 2, email: 'employee2@company.com', password: 'emp123', name: 'Jane Smith', role: 'employee', department: 'HR' }
];

let inventory = [
  { id: 1, name: 'Laptop', category: 'Electronics', quantity: 15, price: 1200, condition: 'Good', serialNumbers: Array.from({length: 15}, (_, i) => `LAP-${1000 + i + 1}`) },
  { id: 2, name: 'Monitor', category: 'Electronics', quantity: 25, price: 300, condition: 'Good', serialNumbers: Array.from({length: 25}, (_, i) => `MON-${1000 + i + 1}`) },
  { id: 3, name: 'Office Chair', category: 'Furniture', quantity: 40, price: 150, condition: 'Good', serialNumbers: Array.from({length: 40}, (_, i) => `CHR-${1000 + i + 1}`) },
  { id: 4, name: 'Desk Lamp', category: 'Furniture', quantity: 30, price: 50, condition: 'Good', serialNumbers: Array.from({length: 30}, (_, i) => `LMP-${1000 + i + 1}`) }
];

let requests = [
  { id: 1, employeeId: 1, employeeName: 'John Doe', itemId: 1, itemName: 'Laptop', quantity: 1, status: 'pending', date: '2024-03-11', reason: 'For new project' }
];

let ownedItems = [];

let sessions = {};

// ============================================
// AUTHENTICATION ROUTES
// ============================================

// Admin Login
app.post('/api/auth/admin-login', (req, res) => {
  const { email, password } = req.body;
  const admin = admins.find(a => a.email === email && a.password === password);
  
  if (admin) {
    const sessionId = Math.random().toString(36).substring(7);
    sessions[sessionId] = { userId: admin.id, role: 'admin', email: admin.email };
    res.json({ 
      status: 'success', 
      message: 'Login successful',
      sessionId: sessionId,
      user: { id: admin.id, name: admin.name, email: admin.email, role: 'admin' }
    });
  } else {
    res.status(401).json({ status: 'error', message: 'Invalid credentials' });
  }
});

// Employee Login
app.post('/api/auth/employee-login', (req, res) => {
  const { email, password } = req.body;
  const employee = employees.find(e => e.email === email && e.password === password);
  
  if (employee) {
    const sessionId = Math.random().toString(36).substring(7);
    sessions[sessionId] = { userId: employee.id, role: 'employee', email: employee.email };
    res.json({ 
      status: 'success', 
      message: 'Login successful',
      sessionId: sessionId,
      user: { id: employee.id, name: employee.name, email: employee.email, role: 'employee', department: employee.department }
    });
  } else {
    res.status(401).json({ status: 'error', message: 'Invalid credentials' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const { sessionId } = req.body;
  delete sessions[sessionId];
  res.json({ status: 'success', message: 'Logged out successfully' });
});

// Verify Session
app.get('/api/auth/verify', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessions[sessionId]) {
    res.json({ status: 'success', user: sessions[sessionId] });
  } else {
    res.status(401).json({ status: 'error', message: 'Invalid session' });
  }
});

// ============================================
// ADMIN ROUTES
// ============================================

// Get all employees
app.get('/api/admin/employees', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'admin') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  res.json({ status: 'success', data: employees });
});

// Create employee
app.post('/api/admin/employees', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'admin') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  
  const { email, password, name, department } = req.body;
  if (!email || !password || !name || !department) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }
  
  const newEmployee = {
    id: Math.max(...employees.map(e => e.id), 0) + 1,
    email, password, name, department, role: 'employee'
  };
  employees.push(newEmployee);
  
  res.status(201).json({ status: 'success', message: 'Employee created', data: newEmployee });
});

// Delete employee
app.delete('/api/admin/employees/:id', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'admin') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  
  const employeeId = parseInt(req.params.id);
  employees = employees.filter(e => e.id !== employeeId);
  
  res.json({ status: 'success', message: 'Employee deleted' });
});

// Get all inventory
app.get('/api/admin/inventory', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'admin') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  res.json({ status: 'success', data: inventory });
});

// Add inventory item
app.post('/api/admin/inventory', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'admin') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  
  const { name, category, quantity, price, condition } = req.body;
  if (!name || !category || !quantity || !price) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }
  
  const newItem = {
    id: Math.max(...inventory.map(i => i.id), 0) + 1,
    name, category, quantity: parseInt(quantity), price: parseFloat(price), condition,
    serialNumbers: Array.from({length: parseInt(quantity)}, (_, i) => `${name.substring(0,3).toUpperCase()}-${Date.now().toString().slice(-4)}-${i+1}`)
  };
  inventory.push(newItem);
  
  res.status(201).json({ status: 'success', message: 'Item added', data: newItem });
});

// Delete inventory item
app.delete('/api/admin/inventory/:id', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'admin') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  
  const itemId = parseInt(req.params.id);
  inventory = inventory.filter(i => i.id !== itemId);
  
  res.json({ status: 'success', message: 'Item deleted' });
});

// Get all requests (admin view)
app.get('/api/admin/requests', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'admin') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  res.json({ status: 'success', data: requests });
});

// Approve/Reject request
app.post('/api/admin/requests/:id/:action', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'admin') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  
  const requestId = parseInt(req.params.id);
  const action = req.params.action;
  const request = requests.find(r => r.id === requestId);
  
  if (!request) {
    return res.status(404).json({ status: 'error', message: 'Request not found' });
  }
  
  if (action === 'approve') {
    const item = inventory.find(i => i.id === request.itemId);
    if (item && item.quantity >= request.quantity) {
      // Transfer serial numbers
      const assignedSerials = item.serialNumbers.splice(0, request.quantity);
      
      assignedSerials.forEach(serial => {
        ownedItems.push({
          id: Math.max(...ownedItems.map(oi => oi.id), 0) + 1 || 1,
          employeeId: request.employeeId,
          itemId: item.id,
          itemName: item.name,
          serialNumber: serial,
          assignedDate: new Date().toISOString().split('T')[0]
        });
      });

      item.quantity -= request.quantity;
      request.status = 'approved';
      res.json({ status: 'success', message: 'Request approved' });
    } else {
      res.status(400).json({ status: 'error', message: 'Insufficient inventory' });
    }
  } else if (action === 'reject') {
    request.status = 'rejected';
    res.json({ status: 'success', message: 'Request rejected' });
  } else {
    res.status(400).json({ status: 'error', message: 'Invalid action' });
  }
});

// Get employee owned items for admin view
app.get('/api/admin/employees/:id/items', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'admin') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  
  const employeeId = parseInt(req.params.id);
  const items = ownedItems.filter(i => i.employeeId === employeeId);
  
  res.json({ status: 'success', data: items });
});

// ============================================
// EMPLOYEE ROUTES
// ============================================

// Get available inventory
app.get('/api/employee/inventory', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'employee') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  res.json({ status: 'success', data: inventory });
});

// Create request
app.post('/api/employee/requests', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'employee') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  
  const { itemId, quantity, reason } = req.body;
  const employee = employees.find(e => e.id === sessions[sessionId].userId);
  const item = inventory.find(i => i.id === itemId);
  
  if (!item || !employee) {
    return res.status(404).json({ status: 'error', message: 'Item or employee not found' });
  }
  
  const newRequest = {
    id: Math.max(...requests.map(r => r.id), 0) + 1,
    employeeId: employee.id,
    employeeName: employee.name,
    itemId: item.id,
    itemName: item.name,
    quantity: parseInt(quantity),
    status: 'pending',
    date: new Date().toISOString().split('T')[0],
    reason: reason || ''
  };
  requests.push(newRequest);
  
  res.status(201).json({ status: 'success', message: 'Request submitted', data: newRequest });
});

// Get my requests
app.get('/api/employee/requests', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'employee') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  
  const employeeId = sessions[sessionId].userId;
  const myRequests = requests.filter(r => r.employeeId === employeeId);
  
  res.json({ status: 'success', data: myRequests });
});

// Get my owned items
app.get('/api/employee/my-items', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId] || sessions[sessionId].role !== 'employee') {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  
  const employeeId = sessions[sessionId].userId;
  const myItems = ownedItems.filter(i => i.employeeId === employeeId);
  
  res.json({ status: 'success', data: myItems });
});

// Dashboard stats
app.get('/api/stats', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessions[sessionId]) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  
  const stats = {
    totalEmployees: employees.length,
    totalItems: inventory.length,
    totalValue: inventory.reduce((sum, i) => sum + (i.price * i.quantity), 0),
    pendingRequests: requests.filter(r => r.status === 'pending').length,
    approvedRequests: requests.filter(r => r.status === 'approved').length
  };
  
  res.json({ status: 'success', data: stats });
});

// Home route
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

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Route not found' });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Admin Login: admin@company.com / admin123`);
  console.log(`Employee Login: employee1@company.com / emp123`);
});
