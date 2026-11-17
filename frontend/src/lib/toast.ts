// Short messages shown at the bottom of the page by the Toast component.
// Kept outside the component tree so any code can call toast().

export interface ToastMessage {
    text: string;
    isError: boolean;
}

type Listener = (message: ToastMessage) => void;

const listeners = new Set<Listener>();

export function toast(text: string, isError = false): void {
    for (const listener of listeners) listener({ text, isError });
}

// Subscribe to messages. Returns a function that unsubscribes.
export function onToast(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
