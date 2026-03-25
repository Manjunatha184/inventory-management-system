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

document.addEventListener('DOMContentLoaded', () => {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar && window.innerWidth <= 768) {
    const btn = document.createElement('button');
    btn.className = 'mobile-menu-btn';
    btn.innerHTML = `<svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>`;
    
    sidebar.parentNode.insertBefore(btn, sidebar);
    
    btn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }
});
