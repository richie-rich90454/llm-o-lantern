/**
 * The application-owned dialogue result format. Every dialogue provider
 * converts its raw vendor response into this shape before the rest of the
 * application sees it.
 */
export class DialogueResponse {
    readonly text: string;
    readonly emotion: string;
    readonly delivery: string;
    readonly providerId: string;

    constructor(text: string, emotion: string, delivery: string, providerId: string) {
        this.text = text;
        this.emotion = emotion;
        this.delivery = delivery;
        this.providerId = providerId;
    }
}
