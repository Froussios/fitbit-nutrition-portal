import { LitElement, html, css } from "lit";
import { customElement, property, query } from "lit/decorators.js";


@customElement("root-element")
export class RootElement extends LitElement {
    constructor() {
        super();
    }

    @property({ type: Object }) data = {};

    async firstUpdated() {
        try {
            const response = await fetch("./data/");
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            this.data = await response.json();
            console.log('data', JSON.stringify(this.data));
        } catch (error) {
            console.error("Failed to fetch data:", error);
        }
    }

    render() {
        return html`
        <div>Rendered successfully</div>
        <table>
            <tr>
                <td>Data:</td>
                <td>${JSON.stringify(this.data)}</td>
            </tr>
        </table>
    `;
    }

    static styles = css`
        div {
            color: green;
        }
  `;
}
