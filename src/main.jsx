import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// NOTE: intentionally NOT wrapped in <React.StrictMode>. StrictMode double-
// invokes effects in dev (mount → cleanup → mount), which opens/closes/reopens
// the chat WebSocket — the first socket's late onclose can clobber the second
// socket's "connected" state. The handler guards in ChatPanel also defend
// against this, but for a throwaway test app it's simplest to skip StrictMode.
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
