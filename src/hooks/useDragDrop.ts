import { useState, type DragEvent } from "react";

/** File drag-and-drop: returns drag state + props to spread on the drop zone. */
export function useDragDrop(onFile: (file: File) => void) {
  const [dragOver, setDragOver] = useState(false);
  return {
    dragOver,
    dropProps: {
      onDragOver: (e: DragEvent) => { e.preventDefault(); setDragOver(true); },
      onDragLeave: () => setDragOver(false),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      },
    },
  };
}
