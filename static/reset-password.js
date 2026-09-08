const form = document.querySelector('#resetForm');
const message = document.querySelector('#message');
const token = new URLSearchParams(location.search).get('token');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  if (values.password !== values.confirmPassword) {
    message.textContent = 'Passwords do not match.';
    return;
  }
  try {
    const response = await fetch('/api/password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: values.password })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Unable to reset password.');
    form.remove();
    message.textContent = result.message;
  } catch (error) {
    message.textContent = error.message;
  }
});
