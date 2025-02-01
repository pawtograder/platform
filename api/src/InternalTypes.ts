import { Exception } from 'tsoa';
export class SecurityError extends Error implements Exception {
    details: string;
    status: number = 401;
    constructor(details: string) {
        super('Security Error');
        this.details = details;
    }
};

export class UserVisibleError extends Error implements Exception {
    details: string;
    status: number = 500;
    constructor(details: string) {
        super('Error');
        this.details = details;
    }
};