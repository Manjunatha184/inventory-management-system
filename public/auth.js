function checkAuth(requiredRole = null) {
  const sessionId = localStorage.getItem('sessionId');
  const userRole = localStorage.getItem('userRole');
  if (!sessionId || !userRole) window.location.href = '/';
  if (requiredRole && userRole !== requiredRole) window.location.href = '/';
}
function logout() {
  localStorage.clear();
  window.location.href = '/';
}
