class AuthService {
    private user: any;

    constructor() {
        // Simulate some initialization
    }

    login(username: string, password: string): boolean {
        // Check if user is set to avoid null pointer
        if (this.user && this.user.name === username) {
            return true;
        }
        return false;
    }

    setUser(user: any) {
        this.user = user;
    }
}