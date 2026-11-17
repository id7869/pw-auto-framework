import { createRoot } from 'react-dom/client';
import { App } from './app';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 容器，index.html 可能被修改');
}

createRoot(container).render(<App />);