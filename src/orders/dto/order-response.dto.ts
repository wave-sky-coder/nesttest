export class UserSummaryDto {
  id: number;
  name: string;
  email: string;
}

export class OrderItemResponseDto {
  productId: number;
  productName: string;
  quantity: number;
  price: number;
}

export class OrderResponseDto {
  id: number;
  total: number;
  status: string;
  user: UserSummaryDto;
  items: OrderItemResponseDto[];
  createdAt: Date;
}
