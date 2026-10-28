import { materialIconUrl } from '../lib/file-icons';
import '../styles/material-file-icons.css';

export function FileIcon(props: { path: string; directory?: boolean; open?: boolean; plain?: boolean; class?: string }) {
  return <span class={`material-file-icon ${props.class ?? ''}`} aria-hidden="true">
    <img class="material-file-icon-dark" src={materialIconUrl(props.path, { directory: props.directory, open: props.open, plain: props.plain })} alt="" draggable={false} />
    <img class="material-file-icon-light" src={materialIconUrl(props.path, { directory: props.directory, open: props.open, plain: props.plain, light: true })} alt="" draggable={false} />
  </span>;
}
